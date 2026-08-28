import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { Ipc } from "@openomni/protocol";
import { connectIpcClient } from "../src/client";
import { IpcConnectionError, IpcTimeoutError } from "../src/errors";
import { LineDecoder } from "../src/framing";
import { createIpcServer } from "../src/server";
import { deferred, within } from "./helpers/signal";
import { socketPath as socketPathForTest } from "./helpers/socket-path";

function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  return new Promise((resolve) => socket.once("connect", () => resolve(socket)));
}

async function exchange(socketPath: string, line: string): Promise<Record<string, unknown>> {
  const socket = await connect(socketPath);
  const decoder = new LineDecoder();
  return new Promise((resolve, reject) => {
    // Bounded failure guard: resolution is event-driven (first decoded frame); the timer only
    // rejects the test instead of hanging when the frame never arrives.
    const timeout = setTimeout(() => reject(new Error("IPC response timeout")), 1_000);
    socket.on("data", (chunk) => {
      const frame = decoder.push(chunk).frames[0];
      if (frame && typeof frame === "object") {
        clearTimeout(timeout);
        socket.destroy();
        resolve(frame as Record<string, unknown>);
      }
    });
    socket.once("error", reject);
    socket.write(line);
  });
}

describe("server edge branches", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const rawSockets: net.Socket[] = [];

  afterEach(() => {
    for (const s of rawSockets.splice(0)) s.destroy();
    for (const s of servers.splice(0)) s.close();
  });

  for (const method of ["machine.run_cell", "machine.call_tool"] as const) {
    test(`${method} without a connected client rejects with IpcConnectionError`, async () => {
      const srv = await createIpcServer(socketPathForTest(`noclient-${method}`), () => undefined);
      servers.push(srv);
      await expect(srv.call(method, {})).rejects.toThrow(IpcConnectionError);
    });
  }

  test("calls in either direction that never get a response reject with IpcTimeoutError", async () => {
    const srv = await createIpcServer(socketPathForTest("timeout"), () => undefined);
    servers.push(srv);
    rawSockets.push(await connect(srv.socketPath));
    await expect(srv.call("machine.run_cell", {}, 30)).rejects.toThrow(IpcTimeoutError);

    const client = await connectIpcClient(srv.socketPath);
    await expect(client.call("machine.attach", {}, 30)).rejects.toBeInstanceOf(
      IpcTimeoutError,
    );
    client.close();
  });

  test("schema-invalid frames get bounded, correlated 4000 responses", async () => {
    const srv = await createIpcServer(socketPathForTest("protocol"), () => undefined);
    servers.push(srv);
    const unknown = await exchange(srv.socketPath, '{"neither":"request-nor-response"}\n');
    expect(unknown.type).toBe("response");
    expect(unknown.id).toBe("unknown");
    expect((unknown.error as { code: number }).code).toBe(4000);

    const correlated = await exchange(
      srv.socketPath,
      '{"v":2,"type":"request","id":"req-correlate-1"}\n',
    );
    expect(correlated.id).toBe("req-correlate-1");
    expect((correlated.error as { code: number }).code).toBe(4000);

    const oversharing = JSON.stringify({ neither: "z".repeat(5_000) });
    const bounded = await exchange(srv.socketPath, `${oversharing}\n`);
    expect((bounded.error as { code: number }).code).toBe(4000);
    expect((bounded.error as { message: string }).message.length).toBeLessThanOrEqual(250);
  });

  test("notification handler failures are contained (sync throw and async rejection)", async () => {
    const seen: string[] = [];
    const bothHandled = deferred();
    const srv = await createIpcServer(socketPathForTest("notify"), (method) => {
      seen.push(method);
      if (seen.length === 2) bothHandled.resolve();
      if (method === "sync.boom") throw new Error("sync failure");
      return Promise.reject(new Error("async failure"));
    });
    servers.push(srv);
    const socket = await connect(srv.socketPath);
    rawSockets.push(socket);

    // Notifications get no error responses per the protocol spec — the
    // server must survive both failure shapes and keep serving.
    socket.write(`${JSON.stringify(Ipc.createNotification("sync.boom", {}))}\n`);
    socket.write(`${JSON.stringify(Ipc.createNotification("async.boom", {}))}\n`);
    await within(bothHandled.promise, "both failing notification handlers");

    expect(seen).toEqual(["sync.boom", "async.boom"]);
    expect(socket.destroyed).toBe(false);
  });

  test("a client that errors mid-connection is removed and the server keeps serving", async () => {
    const disconnected = deferred();
    const srv = await createIpcServer(
      socketPathForTest("sockerr"),
      (_m, _p, respond) => {
        respond({ ok: true });
      },
      { onDisconnect: () => disconnected.resolve() },
    );
    servers.push(srv);

    const first = await connect(srv.socketPath);
    rawSockets.push(first);
    first.on("error", () => {
      // Client-local: destroy(err) emits here; the server observes the close.
    });
    first.destroy(new Error("simulated transport failure"));
    await within(disconnected.promise, "server removal of errored client");

    // Client→server direction is deterministic (no active-connection routing):
    // the fresh client sends a request and must get the handler's response,
    // proving the abrupt first-client death left the server serving.
    const second = await connect(srv.socketPath);
    rawSockets.push(second);
    const reply = new Promise<string>((resolve) => {
      second.once("data", (chunk) => resolve(String(chunk)));
    });
    second.write(`${JSON.stringify(Ipc.createRequest("machine.run_cell", {}))}\n`);
    const frame = JSON.parse(await reply);
    expect(frame.type).toBe("response");
    expect(frame.result).toEqual({ ok: true });
  });
});
