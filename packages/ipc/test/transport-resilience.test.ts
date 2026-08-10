import { describe, test, expect, afterEach } from "bun:test";
import os from "node:os";
import path from "node:path";
import { connectIpcClient } from "../src/client";
import { createIpcServer } from "../src/server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-resil-${label}-${process.pid}.sock`);
}

describe("IPC transport resilience (#QB1)", () => {
  const servers: ReturnType<typeof createIpcServer>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("throwing onRequest handler → typed error frame, not a process crash", async () => {
    const socketPath = tmpSocketPath("throw");
    const srv = createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    const client = await connectIpcClient(socketPath, {
      onRequest(method, _params, respond) {
        if (method === "boom") throw new TypeError("handler blew up");
        respond({ ok: method });
      },
    });
    clients.push(client);

    // Today the throw escapes the socket 'data' listener and crashes the
    // process; fixed, it comes back as a typed error response.
    await expect(srv.call("boom", { x: 1 })).rejects.toThrow("handler blew up");

    // Process + socket survived: a normal request still round-trips.
    expect(await srv.call("ok")).toEqual({ ok: "ok" });
  });

  test("removing the active connection lets the next connection bind", async () => {
    const socketPath = tmpSocketPath("active");
    const srv = createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    const c1 = await connectIpcClient(socketPath, {
      onRequest: (_m, _p, respond) => respond({ from: "c1" }),
    });
    clients.push(c1);
    await Bun.sleep(20);
    srv.useConnection("conn-1");

    const c2 = await connectIpcClient(socketPath, {
      onRequest: (_m, _p, respond) => respond({ from: "c2" }),
    });
    clients.push(c2);
    await Bun.sleep(20);

    // Active connection routes to c1.
    expect(await srv.call("ping")).toEqual({ from: "c1" });

    // Drop the active connection.
    c1.close();
    await Bun.sleep(40);

    // Fixed: activeConnectionId is cleared, so the surviving connection binds.
    // Today it stays pinned to the dead conn-1 and this call finds no socket.
    expect(await srv.call("ping")).toEqual({ from: "c2" });
  });
});
