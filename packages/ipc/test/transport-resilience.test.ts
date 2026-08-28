import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import { connectIpcClient } from "../src/client";
import { IpcConnectionError, IpcRemoteError } from "../src/errors";
import { createIpcServer } from "../src/server";
import { socketPath as socketPathForTest } from "./helpers/socket-path";

describe("IPC transport resilience (#QB1)", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("throwing onRequest handler → typed error frame, not a process crash", async () => {
    const socketPath = socketPathForTest("throw");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    const client = await connectIpcClient(socketPath, {
      onRequest(method, _params, respond) {
        if (method === "boom") throw new TypeError("handler blew up");
        respond({ ok: method });
      },
    });
    clients.push(client);

    // Pre-fix the throw escaped the socket 'data' listener and crashed the
    // process; it now comes back as a typed error response.
    await expect(srv.call("boom", { x: 1 })).rejects.toThrow("handler blew up");

    // Process + socket survived: a normal request still round-trips.
    expect(await srv.call("ok")).toEqual({ ok: "ok" });
  });

  test("removing the active connection lets the next connection bind", async () => {
    const socketPath = socketPathForTest("active");
    const srv = await createIpcServer(socketPath, () => undefined);
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

    // activeConnectionId is cleared on close, so the surviving connection
    // binds (pre-fix it stayed pinned to the dead conn-1 and found no socket).
    expect(await srv.call("ping")).toEqual({ from: "c2" });
  });

  test("ASYNC-rejecting server handler → typed error frame, not a burned timeout", async () => {
    const socketPath = socketPathForTest("async-throw-server");
    const srv = await createIpcServer(socketPath, async (method, _params, respond) => {
      if (method === "boom") throw new TypeError("async handler blew up");
      respond({ ok: method });
    });
    servers.push(srv);
    const client = await connectIpcClient(socketPath);
    clients.push(client);

    // Pre-fix only sync throws were caught; an async rejection escaped and
    // the requester burned its timeout with no error response.
    const error = await client.call("boom", {}, 2_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect((error as Error).message).toContain("async handler blew up");

    // Process + socket survived: a normal request still round-trips.
    expect(await client.call("ok", {}, 2_000)).toEqual({ ok: "ok" });
  });

  test("ASYNC-rejecting client onRequest → typed error frame, not a burned timeout", async () => {
    const socketPath = socketPathForTest("async-throw-client");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {
      onRequest: async (method, _params, respond) => {
        if (method === "boom") throw new TypeError("async client handler blew up");
        respond({ ok: method });
      },
    });
    clients.push(client);

    const error = await srv.call("boom", {}, 2_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect((error as Error).message).toContain("async client handler blew up");
    expect(await srv.call("ok", {}, 2_000)).toEqual({ ok: "ok" });
  });

  test("a schema-mismatch frame is logged by the client, not silently dropped", async () => {
    const socketPath = socketPathForTest("schema-warn");
    // Raw peer that emits valid JSON matching no message schema.
    const rawServer = net.createServer((conn) => {
      conn.write('{"v":2,"type":"mystery"}\n');
    });
    await new Promise<void>((resolve) => rawServer.listen(socketPath, () => resolve()));

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const client = await connectIpcClient(socketPath);
      clients.push(client);
      await Bun.sleep(50);
      expect(warnings.some((w) => w.includes("matched no message schema"))).toBe(true);
      // A drifted peer is surfaced, not fatal: the connection stays usable.
      expect(client.connected).toBe(true);
    } finally {
      console.warn = originalWarn;
      rawServer.close();
    }
  });

  test("createIpcServer refuses to steal a LIVE server's socket", async () => {
    const socketPath = socketPathForTest("live-probe");
    const incumbent = await createIpcServer(socketPath, (_method, _params, respond) =>
      respond({ owner: "incumbent" }),
    );
    servers.push(incumbent);

    // Pre-fix the unconditional unlink silently diverted new connections to
    // the newcomer while the incumbent kept running blind.
    await expect(createIpcServer(socketPath, () => undefined)).rejects.toBeInstanceOf(
      IpcConnectionError,
    );

    // The incumbent is untouched.
    const client = await connectIpcClient(socketPath);
    clients.push(client);
    expect(await client.call("ping", {}, 2_000)).toEqual({ owner: "incumbent" });
  });

  test("a provably dead socket path is reclaimed", async () => {
    const socketPath = socketPathForTest("stale-file");
    fs.writeFileSync(socketPath, ""); // stale leftover: connecting to it fails
    const srv = await createIpcServer(socketPath, (_method, _params, respond) =>
      respond({ ok: true }),
    );
    servers.push(srv);

    const client = await connectIpcClient(socketPath);
    clients.push(client);
    expect(await client.call("ping", {}, 2_000)).toEqual({ ok: true });
  });

  test("notify() reports a drop (false) vs a delivery (true)", async () => {
    const socketPath = socketPathForTest("notify-signal");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    // No connection: the notification is dropped and the caller can tell.
    expect(srv.notify("event.fired", {})).toBe(false);

    const delivered = new Promise<void>((resolve) => {
      connectIpcClient(socketPath, {
        onNotification: (method) => {
          if (method === "event.fired") resolve();
        },
      }).then((c) => clients.push(c));
    });
    await Bun.sleep(20);
    expect(srv.notify("event.fired", {})).toBe(true);
    await delivered;
  });
});
