import { describe, test, expect, afterEach } from "bun:test";
import { connectIpcClient } from "../src/client";
import { createIpcServer } from "../src/server";
import { socketPath as socketPathForTest } from "./helpers/socket-path";

describe("IPC bidirectional", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("client receives incoming Request → onRequest fires → response sent back", async () => {
    const socketPath = socketPathForTest("req");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    const received = { method: "", params: undefined as Record<string, unknown> | undefined };
    const client = await connectIpcClient(socketPath, {
      onRequest(method, params, respond) {
        received.method = method;
        received.params = params;
        respond({ echo: params?.msg });
      },
    });
    clients.push(client);

    const result = await srv.call("ping", { msg: "hello" });

    expect(received.method).toBe("ping");
    expect(received.params).toEqual({ msg: "hello" });
    expect(result).toEqual({ echo: "hello" });
  });

  test("client receives Notification → onNotification fires", async () => {
    const socketPath = socketPathForTest("notif");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    let notifMethod = "";
    let notifParams: Record<string, unknown> | undefined;

    const notifReceived = new Promise<void>((resolve) => {
      connectIpcClient(socketPath, {
        onNotification(method, params) {
          notifMethod = method;
          notifParams = params;
          resolve();
        },
      }).then((c) => clients.push(c));
    });

    await Bun.sleep(20);
    srv.notify("event.fired", { key: "value" });
    await notifReceived;

    expect(notifMethod).toBe("event.fired");
    expect(notifParams).toEqual({ key: "value" });
  });

  test("a throwing/rejecting onNotification never escapes the socket listener", async () => {
    // A throw here would surface as an uncaughtException in the process
    // hosting the client (e.g. the coordinator supervising its workers).
    // The contract mirrors the server: log, keep the connection draining.
    const socketPath = socketPathForTest("notifThrow");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    const seen: string[] = [];
    const client = await connectIpcClient(socketPath, {
      onNotification(method) {
        seen.push(method);
        if (method === "boom.sync") throw new Error("sync handler failure");
        if (method === "boom.async") return Promise.reject(new Error("async handler failure"));
      },
    });
    clients.push(client);

    await Bun.sleep(20);
    expect(srv.notify("boom.sync", {})).toBe(true);
    expect(srv.notify("boom.async", {})).toBe(true);
    expect(srv.notify("after.failures", {})).toBe(true);
    await Bun.sleep(30);

    // Both failures were contained and the connection kept draining: the
    // frame AFTER the failures still reached the handler on the same socket.
    expect(seen).toEqual(["boom.sync", "boom.async", "after.failures"]);
  });

  test("server.call() → client receives → responds → server gets result", async () => {
    const socketPath = socketPathForTest("srvCall");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    const client = await connectIpcClient(socketPath, {
      onRequest(_method, params, respond) {
        respond({ doubled: ((params?.n as number) ?? 0) * 2 });
      },
    });
    clients.push(client);

    const result = await srv.call("compute", { n: 21 });
    expect(result).toEqual({ doubled: 42 });
  });

  test("existing client.call() flow unchanged", async () => {
    const socketPath = socketPathForTest("clientCall");
    const srv = await createIpcServer(socketPath, (method, params, respond) => {
      if (method === "echo") respond({ got: params?.v });
    });
    servers.push(srv);

    const client = await connectIpcClient(socketPath);
    clients.push(client);

    const result = await client.call("echo", { v: "unchanged" });
    expect(result).toEqual({ got: "unchanged" });
  });
});
