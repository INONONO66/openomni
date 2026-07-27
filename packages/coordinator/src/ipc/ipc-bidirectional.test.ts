import { describe, test, expect, afterEach } from "bun:test";
import os from "node:os";
import path from "node:path";
import { connectIpcClient } from "./client";
import { createIpcServer } from "./server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-bidir-${label}-${process.pid}.sock`);
}

const bootstrapParams = {
  authToken: "token",
  runtimeId: "runtime-1",
  workerId: "worker-1",
  generation: 1,
  configEpoch: "epoch-1",
};

async function activateConnection(
  client: Awaited<ReturnType<typeof connectIpcClient>>,
): Promise<void> {
  await client.call("coordinator.bootstrap", bootstrapParams);
  await Bun.sleep(1);
}

describe("IPC bidirectional", () => {
  const servers: ReturnType<typeof createIpcServer>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("client receives a closed Request and returns its strict result", async () => {
    const socketPath = tmpSocketPath("req");
    let activeServer: ReturnType<typeof createIpcServer> | undefined;
    const srv = createIpcServer(socketPath, (method, _params, respond, _notify, connectionId) => {
      if (method !== "coordinator.bootstrap") return;
      if (!activeServer) throw new Error("IPC server was not initialized");
      activeServer.useConnection(connectionId);
      respond({ ok: true });
    });
    activeServer = srv;
    servers.push(srv);

    const received = { method: "", params: undefined as Record<string, unknown> | undefined };
    const client = await connectIpcClient(socketPath, {
      onRequest(method, params, respond) {
        received.method = method;
        received.params = params;
        respond(null);
      },
    });
    clients.push(client);
    await activateConnection(client);
    const params = {
      authToken: "token",
      workerId: "worker-1",
      generation: 1,
      sessionId: "session-1",
      runId: "run-1",
      observation: { name: "fixture", data: { ok: true } },
    };

    const result = await srv.call("worker.observation", params);

    expect(received.method).toBe("worker.observation");
    expect(received.params).toEqual(params);
    expect(result).toBeNull();
  });

  test("client receives a closed Notification", async () => {
    const socketPath = tmpSocketPath("notif");
    let activeServer: ReturnType<typeof createIpcServer> | undefined;
    const srv = createIpcServer(socketPath, (method, _params, respond, _notify, connectionId) => {
      if (method !== "coordinator.bootstrap") return;
      if (!activeServer) throw new Error("IPC server was not initialized");
      activeServer.useConnection(connectionId);
      respond({ ok: true });
    });
    activeServer = srv;
    servers.push(srv);
    let notification: { method: string; params?: Record<string, unknown> } | undefined;
    let resolveNotification: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      resolveNotification = resolve;
    });
    const client = await connectIpcClient(socketPath, {
      onNotification(method, params) {
        notification = { method, params };
        if (!resolveNotification) {
          throw new Error("notification resolver was not initialized");
        }
        resolveNotification();
      },
    });
    clients.push(client);
    await Bun.sleep(20);
    await activateConnection(client);
    const params = {
      authToken: "proof",
      runtimeId: "runtime-1",
      workerId: "worker-1",
      generation: 1,
    };
    srv.notify("worker.bootstrap_ready", params);
    await received;
    expect(notification).toEqual({ method: "worker.bootstrap_ready", params });
  });

  test("server.call validates the client result", async () => {
    const socketPath = tmpSocketPath("srvCall");
    let activeServer: ReturnType<typeof createIpcServer> | undefined;
    const srv = createIpcServer(socketPath, (method, _params, respond, _notify, connectionId) => {
      if (method !== "coordinator.bootstrap") return;
      if (!activeServer) throw new Error("IPC server was not initialized");
      activeServer.useConnection(connectionId);
      respond({ ok: true });
    });
    activeServer = srv;
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {
      onRequest(_method, _params, respond) {
        respond(null);
      },
    });
    clients.push(client);
    await activateConnection(client);
    await expect(
      srv.call("worker.observation", {
        authToken: "token",
        workerId: "worker-1",
        generation: 1,
        sessionId: "session-1",
        runId: "run-1",
        observation: { name: "fixture", data: null },
      }),
    ).resolves.toBeNull();
  });

  test("client.call validates the server result", async () => {
    const socketPath = tmpSocketPath("clientCall");
    const srv = createIpcServer(socketPath, (method, _params, respond) => {
      if (method === "coordinator.cancel_run") respond({ cancelled: true });
    });
    servers.push(srv);
    const client = await connectIpcClient(socketPath);
    clients.push(client);
    await expect(
      client.call("coordinator.cancel_run", {
        authToken: "token",
        runId: "run-1",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ cancelled: true });
  });
});
