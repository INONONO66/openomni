import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { Ipc } from "@openomni/protocol";
import { connectIpcClient } from "../src/client";
import { IpcConnectionError, IpcProtocolError, IpcRemoteError } from "../src/errors";
import { LineDecoder, encode } from "../src/framing";
import { createIpcServer } from "../src/server";
import { deferred, within } from "./helpers/signal";
import { socketPath as socketPathForTest } from "./helpers/socket-path";

describe("failure classes stay honest (#606 re-audit)", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];
  const rawSockets: net.Socket[] = [];

  afterEach(() => {
    for (const s of rawSockets.splice(0)) s.destroy();
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
  });

  test("public IPC errors use the shared serializable error contract", () => {
    const connection = new IpcConnectionError("closed");
    const remote = new IpcRemoteError(4000, "bad request");
    expect(IpcConnectionError.isInstance(connection)).toBe(true);
    expect(connection.toObject()).toEqual({
      name: "IpcConnectionError",
      data: { message: "closed" },
    });
    expect(IpcRemoteError.isInstance(remote)).toBe(true);
    expect(remote.code).toBe(4000);
    expect(remote.message).toBe("IPC error 4000: bad request");
  });

  test("IPC constructors retain defined falsy causes but omit undefined", () => {
    const nullCause = new IpcConnectionError("closed", null);
    const falseCause = new IpcProtocolError("bad frame", false);
    const emptyCause = new IpcConnectionError("empty", "");
    const undefinedCause = new IpcProtocolError("absent", undefined);

    for (const [error, cause] of [
      [nullCause, null],
      [falseCause, false],
      [emptyCause, ""],
    ] as const) {
      expect(Object.getOwnPropertyDescriptor(error, "cause") !== undefined).toBe(true);
      expect(Reflect.get(error, "cause")).toBe(cause);
    }
    expect(Object.getOwnPropertyDescriptor(undefinedCause, "cause") !== undefined).toBe(false);
  });

  test("a dying connection fails ITS in-flight calls as connection loss, not timeout", async () => {
    const socketPath = socketPathForTest("per-conn");
    let survivorConnectionId: string | undefined;
    const dyingReceivedRequest = deferred();
    const srv = await createIpcServer(
      socketPath,
      (method, _params, respond, _notify, connectionId) => {
        if (method === "register-survivor") survivorConnectionId = connectionId;
        respond({ ok: true });
      },
    );
    servers.push(srv);

    // First connection never answers server calls; it will die mid-flight.
    const dying = await connectIpcClient(socketPath, {
      onRequest: () => {
        dyingReceivedRequest.resolve();
        // Deliberately never responds.
      },
    });
    clients.push(dying);

    const inFlight = srv.call("hang", {}, 5_000);
    await within(dyingReceivedRequest.promise, "dying peer receiving in-flight request");

    // A second connection joins; the pool is not empty when the first dies.
    const survivor = await connectIpcClient(socketPath, {
      onRequest: (_method, _params, respond) => {
        respond({ from: "survivor" });
      },
    });
    clients.push(survivor);

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
    const socketPath = socketPathForTest("no-handler");
    const srv = await createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ ok: true });
    });
    servers.push(srv);

    const client = await connectIpcClient(socketPath, {});
    clients.push(client);

    // Pre-fix: the request was silently dropped and the server's call aged
    // out as a timeout.
    const error = await srv.call("do-thing", {}, 2_000).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect((error as Error).message).toContain("client has no request handler for do-thing");
  });

  test("a valid response sharing a chunk with a bad line still resolves the call", async () => {
    const socketPath = socketPathForTest("shared-chunk");
    const srv = await createIpcServer(socketPath, (_method, _params, respond) => {
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

    // Pre-fix: the malformed line's throw re-queued the trailing response for
    // the NEXT data event that never came, so the call stalled to
    // IpcTimeoutError. Skip-and-report must resolve it from the same chunk.
    expect(await srv.call("ping", {}, 2_000)).toEqual({ via: "raw" });
  });

  test("each malformed line is answered with its own 4001 error frame", async () => {
    const socketPath = socketPathForTest("per-line-4001");
    const srv = await createIpcServer(socketPath, (_method, _params, respond) => {
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

  test("an oversize frame gets a 4001 and then the server CLOSES the connection", async () => {
    const socketPath = socketPathForTest("oversize-close");
    const srv = await createIpcServer(socketPath, (_method, _params, respond) =>
      respond({ ok: true }),
    );
    servers.push(srv);

    const socket = net.createConnection(socketPath);
    rawSockets.push(socket);
    socket.on("error", () => undefined); // EPIPE from the server-side close is expected
    const decoder = new LineDecoder();
    const frames: unknown[] = [];
    socket.on("data", (chunk) => frames.push(...decoder.push(chunk).frames));
    // The FIN is the server's close: a peer mid-flood (this one) can never
    // complete the full close from its side, so 'end' is the observable.
    const serverClosed = new Promise<void>((resolve) => socket.once("end", () => resolve()));
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    // No newline needed: the decode-buffer cap trips mid-frame, which resets
    // the decoder MID-frame — everything after would parse as garbage, so the
    // server must not keep the desynced connection alive (pre-fix it did).
    socket.write("x".repeat(17 * 1024 * 1024));
    await within(serverClosed, "server FIN after oversize frame", 12_000);

    const errorFrame = frames.at(-1) as { id?: string; error?: { code?: number } } | undefined;
    expect(errorFrame?.error?.code).toBe(4001);
    expect(errorFrame?.id).toBe("unknown");
  }, 15_000);

  test("a client that sent an oversize frame fails fast, not by burning its timeout", async () => {
    const socketPath = socketPathForTest("oversize-client");
    const srv = await createIpcServer(socketPath, (_method, _params, respond) =>
      respond({ ok: true }),
    );
    servers.push(srv);
    const client = await connectIpcClient(socketPath);
    clients.push(client);

    // Pre-fix the server kept the desynced connection open and the pending
    // aged out over the full 30s timeout; now the symmetric close rejects it
    // as a connection loss within the test's own budget.
    const disconnected = client
      .call("big", { data: "y".repeat(17 * 1024 * 1024) }, 30_000)
      .catch((e: unknown) => e);
    const error = await within(disconnected, "client rejection after oversize frame", 12_000);
    expect(error).toBeInstanceOf(IpcConnectionError);
  }, 15_000);

  test("an error frame carrying the request's id settles the requester's pending", async () => {
    const socketPath = socketPathForTest("correlated-4000");
    // Raw peer: answers ANY request with a 4000 error echoing the request id —
    // the shape the server now emits for schema-invalid frames that carry one.
    const rawServer = net.createServer((conn) => {
      const decoder = new LineDecoder();
      conn.on("data", (chunk) => {
        for (const raw of decoder.push(chunk).frames) {
          const request = Ipc.Request.safeParse(raw);
          if (!request.success) continue;
          conn.write(
            `${JSON.stringify(Ipc.createErrorResponse(request.data.id, 4000, "peer rejected the frame"))}\n`,
          );
        }
      });
    });
    await new Promise<void>((resolve) => rawServer.listen(socketPath, () => resolve()));

    try {
      const client = await connectIpcClient(socketPath);
      clients.push(client);
      // A correlated 4000 must reject the pending NOW — "unknown" would let
      // the 30s timeout burn instead.
      const error = await client.call("anything", {}, 30_000).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IpcRemoteError);
      expect((error as IpcRemoteError).code).toBe(4000);
      expect((error as Error).message).toContain("peer rejected the frame");
    } finally {
      rawServer.close();
    }
  });

  test("a response arriving on a connection that does not own the request is ignored", async () => {
    const socketPath = socketPathForTest("cross-conn");
    const forgedResponseProcessed = deferred();
    const srv = await createIpcServer(socketPath, (method, _params, respond) => {
      if (method === "forged-response-barrier") forgedResponseProcessed.resolve();
      respond({ ok: true });
    });
    servers.push(srv);

    // conn A receives the server's request and answers LAST.
    const connA = net.createConnection(socketPath);
    rawSockets.push(connA);
    const decoderA = new LineDecoder();
    let requestId: string | undefined;
    const gotRequest = new Promise<void>((resolve) => {
      connA.on("data", (chunk) => {
        for (const raw of decoderA.push(chunk).frames) {
          const request = Ipc.Request.safeParse(raw);
          if (request.success) {
            requestId = request.data.id;
            resolve();
          }
        }
      });
    });
    await new Promise<void>((resolve) => connA.once("connect", () => resolve()));

    const connB = net.createConnection(socketPath);
    rawSockets.push(connB);
    await new Promise<void>((resolve) => connB.once("connect", () => resolve()));

    // Unpinned: the request routes to the first connection (conn A).
    const inFlight = srv.call("job", {}, 5_000);
    let settled = false;
    inFlight.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await gotRequest;
    if (!requestId) throw new Error("request id was never captured");

    // conn B echoes conn A's request id. A following notification on the
    // same stream is an exact processing barrier for the forged response.
    connB.write(
      `${JSON.stringify(Ipc.createResponse(requestId, { from: "B" }))}\n${JSON.stringify(
        Ipc.createNotification("forged-response-barrier", {}),
      )}\n`,
    );
    await within(forgedResponseProcessed.promise, "foreign response processing barrier");
    expect(settled).toBe(false);

    // Only the owning connection's answer resolves it.
    connA.write(`${JSON.stringify(Ipc.createResponse(requestId, { from: "A" }))}\n`);
    expect(await inFlight).toEqual({ from: "A" });
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

describe("client remote-error path (#606 audit)", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
  });

  test("an error frame REJECTS the call as IpcRemoteError — never resolves undefined", async () => {
    const socketPath = socketPathForTest("reject");
    const srv = await createIpcServer(socketPath, (method, _params, _respond) => {
      // A throwing handler produces the server's typed error frame (code 1000).
      throw new Error(`remote refused ${method}`);
    });
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {});
    clients.push(client);

    // Pin: pre-fix this path was untested repo-wide (deleting the mapping
    // made remote failures resolve `undefined` with every suite green), and
    // the rejection class was IpcConnectionError — misfiling a healthy
    // connection's remote failure as a transport problem.
    const error = await client.call("do-thing", {}, 2_000).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect((error as Error).message).toContain("remote refused do-thing");
    expect(error).not.toBeInstanceOf(IpcConnectionError);
    expect((error as IpcRemoteError).code).toBe(1000);
  });

  test("the SERVER side of the socket files remote failures the same way (#677 review)", async () => {
    const socketPath = socketPathForTest("server-side");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {
      onRequest: () => {
        // A throwing client-side handler becomes the code-1000 error frame
        // the server.call path receives.
        throw new Error("client handler refused");
      },
    });
    clients.push(client);

    const error = await srv.call("do-thing", {}, 2_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error).not.toBeInstanceOf(IpcConnectionError);
    expect(String((error as Error).message)).toContain("client handler refused");
  });
});
