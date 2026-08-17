import { describe, test, expect, afterEach } from "bun:test";
import os from "node:os";
import path from "node:path";
import { connectIpcClient } from "../src/client";
import { createIpcServer } from "../src/server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-bidir-${label}-${process.pid}.sock`);
}

describe("IPC bidirectional", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("client receives incoming Request → onRequest fires → response sent back", async () => {
    const socketPath = tmpSocketPath("req");
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
    const socketPath = tmpSocketPath("notif");
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

  test("server.call() → client receives → responds → server gets result", async () => {
    const socketPath = tmpSocketPath("srvCall");
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
    const socketPath = tmpSocketPath("clientCall");
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
