import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Ipc } from "@openomni/protocol";
import { connectIpcClient } from "../src/client";
import { IpcConnectionError, IpcTimeoutError } from "../src/errors";
import { LineDecoder } from "../src/framing";
import { createIpcServer } from "../src/server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-edge-${label}-${process.pid}.sock`);
}

function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  return new Promise((resolve) => socket.once("connect", () => resolve(socket)));
}

async function exchange(socketPath: string, line: string): Promise<Record<string, unknown>> {
  const socket = await connect(socketPath);
  const decoder = new LineDecoder();
  return new Promise((resolve, reject) => {
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

  afterEach(async () => {
    for (const s of rawSockets.splice(0)) s.destroy();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  for (const method of ["worker.shutdown_idle", "worker.deliver_message"] as const) {
    test(`${method} without a connected client rejects with IpcConnectionError`, async () => {
      const srv = await createIpcServer(tmpSocketPath(`noclient-${method}`), () => undefined);
      servers.push(srv);
      await expect(srv.call(method, {})).rejects.toThrow(IpcConnectionError);
    });
  }

  test("calls in either direction that never get a response reject with IpcTimeoutError", async () => {
    const srv = await createIpcServer(tmpSocketPath("timeout"), () => undefined);
    servers.push(srv);
    rawSockets.push(await connect(srv.socketPath));
    await Bun.sleep(20);
    expect(srv.call("worker.shutdown_idle", {}, 30)).rejects.toThrow(IpcTimeoutError);

    const client = await connectIpcClient(srv.socketPath);
    await expect(client.call("coordinator.bootstrap", {}, 30)).rejects.toBeInstanceOf(IpcTimeoutError);
    client.close();
  });

  test("schema-invalid frames get bounded, correlated 4000 responses", async () => {
    const srv = await createIpcServer(tmpSocketPath("protocol"), () => undefined);
    servers.push(srv);
    const unknown = await exchange(srv.socketPath, '{"neither":"request-nor-response"}\n');
    expect(unknown.type).toBe("response");
    expect(unknown.id).toBe("unknown");
    expect((unknown.error as { code: number }).code).toBe(4000);

    const correlated = await exchange(srv.socketPath, '{"v":2,"type":"request","id":"req-correlate-1"}\n');
    expect(correlated.id).toBe("req-correlate-1");
    expect((correlated.error as { code: number }).code).toBe(4000);

    const oversharing = JSON.stringify({ neither: "z".repeat(5_000) });
    const bounded = await exchange(srv.socketPath, `${oversharing}\n`);
    expect((bounded.error as { code: number }).code).toBe(4000);
    expect((bounded.error as { message: string }).message.length).toBeLessThanOrEqual(250);
  });

  test("notification handler failures are contained (sync throw and async rejection)", async () => {
    const seen: string[] = [];
    const srv = await createIpcServer(tmpSocketPath("notify"), (method) => {
      seen.push(method);
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
    await Bun.sleep(50);

    expect(seen).toEqual(["sync.boom", "async.boom"]);
    expect(socket.destroyed).toBe(false);
  });

  test("a client that errors mid-connection is removed and the server keeps serving", async () => {
    const srv = await createIpcServer(tmpSocketPath("sockerr"), (_m, _p, respond) => {
      respond({ ok: true });
    });
    servers.push(srv);

    const first = await connect(srv.socketPath);
    rawSockets.push(first);
    first.on("error", () => {
      // Client-local: destroy(err) emits here; the server observes the close.
    });
    await Bun.sleep(20);
    first.destroy(new Error("simulated transport failure"));
    await Bun.sleep(30);

    // Client→server direction is deterministic (no active-connection routing):
    // the fresh client sends a request and must get the handler's response,
    // proving the abrupt first-client death left the server serving.
    const second = await connect(srv.socketPath);
    rawSockets.push(second);
    const reply = new Promise<string>((resolve) => {
      second.once("data", (chunk) => resolve(String(chunk)));
    });
    second.write(`${JSON.stringify(Ipc.createRequest("worker.shutdown_idle", {}))}\n`);
    const frame = JSON.parse(await reply);
    expect(frame.type).toBe("response");
    expect(frame.result).toEqual({ ok: true });
  });
});
