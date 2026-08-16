import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Ipc } from "@openomni/protocol";
import { connectIpcClient } from "../src/client";
import { IpcConnectionError, IpcRemoteError } from "../src/errors";
import { LineDecoder, encode } from "../src/framing";
import { createIpcServer } from "../src/server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-classes-${label}-${process.pid}.sock`);
}

describe("failure classes stay honest (#606 re-audit)", () => {
  const servers: ReturnType<typeof createIpcServer>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];
  const rawSockets: net.Socket[] = [];

  afterEach(async () => {
    for (const s of rawSockets.splice(0)) s.destroy();
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("a dying connection fails ITS in-flight calls as connection loss, not timeout", async () => {
    const socketPath = tmpSocketPath("per-conn");
    let survivorConnectionId: string | undefined;
    const srv = createIpcServer(socketPath, (method, _params, respond, _notify, connectionId) => {
      if (method === "register-survivor") survivorConnectionId = connectionId;
      respond({ ok: true });
    });
    servers.push(srv);

    // First connection never answers server calls; it will die mid-flight.
    const dying = await connectIpcClient(socketPath, {
      onRequest: () => {
        /* deliberately never responds */
      },
    });
    clients.push(dying);
    await Bun.sleep(10);

    const inFlight = srv.call("hang", {}, 5_000);
    await Bun.sleep(10);

    // A second connection joins; the pool is not empty when the first dies.
    const survivor = await connectIpcClient(socketPath, {
      onRequest: (_method, _params, respond) => {
        respond({ from: "survivor" });
      },
    });
    clients.push(survivor);
    await Bun.sleep(10);

    // Learn the survivor's connection id from the RequestHandler's own
    // connection-id argument rather than hardcoding the counter's "conn-2".
    await survivor.call("register-survivor", {});
    if (!survivorConnectionId) throw new Error("survivor connection id was never captured");

    dying.close();
    // Pre-fix: with a survivor still connected, the dead connection's
    // in-flight request lingered to IpcTimeoutError — misfiling a transport
    // loss as slowness.
    await expect(inFlight).rejects.toBeInstanceOf(IpcConnectionError);

    // The surviving connection is still usable.
    srv.useConnection(survivorConnectionId);
    expect(await srv.call("ping", {}, 2_000)).toEqual({ from: "survivor" });
  });

  test("a handlerless client answers server calls with a typed remote failure", async () => {
    const socketPath = tmpSocketPath("no-handler");
    const srv = createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ ok: true });
    });
    servers.push(srv);

    const client = await connectIpcClient(socketPath, {});
    clients.push(client);
    await Bun.sleep(10);

    // Pre-fix: the request was silently dropped and the server's call aged
    // out as a timeout.
    const rejection = srv.call("do-thing", {}, 2_000);
    await expect(rejection).rejects.toBeInstanceOf(IpcRemoteError);
    await expect(srv.call("do-thing", {}, 2_000)).rejects.toThrow(
      "client has no request handler for do-thing",
    );
  });

  test("a valid response sharing a chunk with a bad line still resolves the call", async () => {
    const socketPath = tmpSocketPath("shared-chunk");
    const srv = createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ ok: true });
    });
    servers.push(srv);

    // Raw socket client: answer the server's request with ONE chunk that puts
    // a malformed line ahead of the valid response.
    const socket = net.createConnection(socketPath);
    rawSockets.push(socket);
    const decoder = new LineDecoder();
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.on("data", (chunk) => {
      const { frames } = decoder.push(chunk);
      for (const raw of frames) {
        const request = Ipc.Request.safeParse(raw);
        if (!request.success) continue;
        const response = JSON.stringify(Ipc.createResponse(request.data.id, { via: "raw" }));
        socket.write(`this is not json\n${response}\n`);
      }
    });
    await Bun.sleep(10);

    // Pre-fix: the malformed line's throw re-queued the trailing response for
    // the NEXT data event that never came, so the call stalled to
    // IpcTimeoutError. Skip-and-report must resolve it from the same chunk.
    expect(await srv.call("ping", {}, 2_000)).toEqual({ via: "raw" });
  });

  test("each malformed line is answered with its own 4001 error frame", async () => {
    const socketPath = tmpSocketPath("per-line-4001");
    const srv = createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ ok: true });
    });
    servers.push(srv);

    const socket = net.createConnection(socketPath);
    rawSockets.push(socket);
    const decoder = new LineDecoder();
    const errorFrames: { id: string; code: number | undefined }[] = [];
    const twoErrors = new Promise<void>((resolve) => {
      socket.on("data", (chunk) => {
        const { frames } = decoder.push(chunk);
        for (const raw of frames) {
          const response = Ipc.Response.safeParse(raw);
          if (!response.success) continue;
          errorFrames.push({ id: response.data.id, code: response.data.error?.code });
          if (errorFrames.length === 2) resolve();
        }
      });
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    socket.write("garbage-one\ngarbage-two\n");
    await twoErrors;
    expect(errorFrames).toEqual([
      { id: "unknown", code: 4001 },
      { id: "unknown", code: 4001 },
    ]);
  });

  test("encode/decode round-trip is unaffected", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encode({ id: "rt" }))).toEqual({ frames: [{ id: "rt" }], malformed: [] });
  });
});

describe("LineDecoder malformed-frame isolation (#606 re-audit, #685 skip-and-report)", () => {
  test("one malformed line costs only itself — every parseable sibling delivers immediately", () => {
    const decoder = new LineDecoder();
    const good1 = { id: "1", kind: "a" };
    const good2 = { id: "2", kind: "b" };
    const chunk = `${JSON.stringify(good1)}\n{not json}\n${JSON.stringify(good2)}\n{"id":"3"`;

    // Pre-fix: the throw discarded good1 (frames parsed before the bad line)
    // and re-queued good2 for a later push. Skip-and-report delivers both now.
    const result = decoder.push(chunk);
    expect(result.frames).toEqual([good1, good2]);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]).toBe("{not json}");

    // The trailing partial line completes on the next push, malformed-free.
    const next = decoder.push(new TextEncoder().encode("}\n"));
    expect(next).toEqual({ frames: [{ id: "3" }], malformed: [] });
  });
});
