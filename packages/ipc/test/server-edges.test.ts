import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Ipc } from "@openomni/protocol";
import { IpcConnectionError, IpcTimeoutError } from "../src/errors";
import { createIpcServer } from "../src/server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-edge-${label}-${process.pid}.sock`);
}

function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  return new Promise((resolve) => socket.once("connect", () => resolve(socket)));
}

describe("server edge branches", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const rawSockets: net.Socket[] = [];

  afterEach(async () => {
    for (const s of rawSockets.splice(0)) s.destroy();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("call without a connected client rejects with IpcConnectionError", async () => {
    const srv = await createIpcServer(tmpSocketPath("noclient"), () => undefined);
    servers.push(srv);
    expect(srv.call("worker.shutdown_idle", {})).rejects.toThrow(IpcConnectionError);
  });

  test("call that never gets a response rejects with IpcTimeoutError", async () => {
    const srv = await createIpcServer(tmpSocketPath("timeout"), () => undefined);
    servers.push(srv);
    // A silent client: connected, never responds.
    rawSockets.push(await connect(srv.socketPath));
    await Bun.sleep(20);
    expect(srv.call("worker.shutdown_idle", {}, 30)).rejects.toThrow(IpcTimeoutError);
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

    const second = await connect(srv.socketPath);
    rawSockets.push(second);
    // CI schedulers can lag the dead-connection sweep — poll until the server
    // routes to the fresh client instead of pinning one sleep length.
    let result: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        result = await srv.call("worker.shutdown_idle", {}, 500);
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(result).toEqual({ ok: true });
  });
});
