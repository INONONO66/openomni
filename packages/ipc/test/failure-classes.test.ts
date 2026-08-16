import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { connectIpcClient } from "../src/client";
import { IpcConnectionError, IpcProtocolError, IpcRemoteError } from "../src/errors";
import { LineDecoder, encode } from "../src/framing";
import { createIpcServer } from "../src/server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-classes-${label}-${process.pid}.sock`);
}

describe("failure classes stay honest (#606 re-audit)", () => {
  const servers: ReturnType<typeof createIpcServer>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("a dying connection fails ITS in-flight calls as connection loss, not timeout", async () => {
    const socketPath = tmpSocketPath("per-conn");
    const srv = createIpcServer(socketPath, (_method, _params, respond) => {
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

    dying.close();
    // Pre-fix: with a survivor still connected, the dead connection's
    // in-flight request lingered to IpcTimeoutError — misfiling a transport
    // loss as slowness.
    await expect(inFlight).rejects.toBeInstanceOf(IpcConnectionError);

    // The surviving connection is still usable.
    srv.useConnection("conn-2");
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
});

describe("LineDecoder malformed-frame isolation (#606 re-audit)", () => {
  test("one malformed line costs only itself — siblings survive on the buffer", () => {
    const decoder = new LineDecoder();
    const good1 = { id: "1", kind: "a" };
    const good2 = { id: "2", kind: "b" };
    const chunk = `${JSON.stringify(good1)}\n{not json}\n${JSON.stringify(good2)}\n`;

    let thrown: unknown;
    let frames: unknown[] = [];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IpcProtocolError);
    expect(frames).toEqual([]);

    // The sibling after the malformed line was re-queued, not discarded:
    // the next push delivers it first, in order.
    const next = decoder.push(new TextEncoder().encode(`${JSON.stringify({ id: "3" })}\n`));
    expect(next).toEqual([good2, { id: "3" }]);
  });

  test("encode/decode round-trip is unaffected", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encode({ id: "rt" }))).toEqual([{ id: "rt" }]);
  });
});
