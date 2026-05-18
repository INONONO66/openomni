import { afterEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "@openomni/agent";
import { z } from "zod";

import { WorkerBootstrapHandler } from "../../src/execution/worker-bootstrap-handler";

const NotificationRecord = z.object({
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
type NotificationRecord = z.infer<typeof NotificationRecord>;

function createServer() {
  const usedConnections: string[] = [];
  const notifications: NotificationRecord[] = [];

  return {
    usedConnections,
    notifications,
    server: {
      useConnection(id: string) {
        usedConnections.push(id);
      },
      notify(method: string, params?: Record<string, unknown>) {
        notifications.push({ method, params });
      },
    } satisfies WorkerBootstrapHandler.ServerPort,
  };
}

describe("worker bootstrap handler", () => {
  afterEach(() => {
    AgentRegistry.clear();
  });

  it("rejects unauthorized bootstrap requests without mutating state", () => {
    const state = WorkerBootstrapHandler.createState();
    const { server, usedConnections, notifications } = createServer();
    const responses: unknown[] = [];

    WorkerBootstrapHandler.handleBootstrap({
      params: { authToken: "wrong", bootstrap: {} },
      ipcAuthToken: "token",
      workerId: "worker-1",
      server,
      connectionId: "conn-1",
      respond: (result) => responses.push(result),
      state,
    });

    expect(responses).toEqual([{ ok: false, error: "unauthorized" }]);
    expect(state.getBootstrap()).toBeNull();
    expect(state.resolveAuth("openai")).toBeUndefined();
    expect(usedConnections).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("stores valid bootstrap data, marks readiness, and exposes scoped auth", async () => {
    let mirroredEpoch: string | undefined;
    const state = WorkerBootstrapHandler.createState({
      onBootstrap: (bootstrap) => {
        mirroredEpoch = bootstrap.configEpoch;
      },
    });
    const { server, usedConnections, notifications } = createServer();
    const responses: unknown[] = [];

    WorkerBootstrapHandler.handleBootstrap({
      params: {
        authToken: "token",
        bootstrap: {
          configEpoch: "epoch-1",
          agents: [
            {
              name: "planner",
              description: "Plans work",
              systemPrompt: "Plan carefully",
              tools: { allow: ["read"] },
              policyPlan: {
                policies: [{ id: "builtin:tool-permission", required: true }],
                labels: ["planner"],
              },
            },
          ],
          toolCatalog: [],
          credentials: {
            OPENAI_API_KEY: "openai-key",
            ANTHROPIC_BASE_URL: "https://anthropic.example",
            ANTHROPIC_API_KEY: "anthropic-key",
          },
        },
      },
      ipcAuthToken: "token",
      workerId: "worker-1",
      server,
      connectionId: "conn-1",
      respond: (result) => responses.push(result),
      state,
    });

    await state.ready;

    expect(responses).toEqual([{ ok: true }]);
    expect(state.getBootstrap()?.configEpoch).toBe("epoch-1");
    expect(AgentRegistry.get("planner")).toMatchObject({
      name: "planner",
      description: "Plans work",
      systemPrompt: "Plan carefully",
      tools: ["read"],
      policyPlan: {
        policies: [{ id: "builtin:tool-permission", required: true }],
        labels: ["planner"],
      },
    });
    expect(mirroredEpoch).toBe("epoch-1");
    expect(state.resolveAuth("openai")).toEqual({ type: "api", key: "openai-key" });
    expect(state.resolveAuth("anthropic")).toEqual({
      type: "proxy",
      baseURL: "https://anthropic.example",
      apiKey: "anthropic-key",
    });
    expect(usedConnections).toEqual(["conn-1"]);
    expect(notifications).toEqual([
      {
        method: "worker.bootstrap_ready",
        params: { workerId: "worker-1", authToken: "token" },
      },
    ]);
  });

  it("reports parse failures and rejects readiness", async () => {
    const state = WorkerBootstrapHandler.createState();
    const { server } = createServer();
    const responses: unknown[] = [];

    WorkerBootstrapHandler.handleBootstrap({
      params: {
        authToken: "token",
        bootstrap: { configEpoch: "epoch-1", agents: "not-an-array", toolCatalog: [] },
      },
      ipcAuthToken: "token",
      workerId: "worker-1",
      server,
      connectionId: "conn-1",
      respond: (result) => responses.push(result),
      state,
    });

    await expect(state.ready).rejects.toThrow();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ ok: false });
    expect(state.getBootstrap()).toBeNull();
  });

  it("does not mark readiness when connection activation fails", async () => {
    const state = WorkerBootstrapHandler.createState();
    const responses: unknown[] = [];

    WorkerBootstrapHandler.handleBootstrap({
      params: {
        authToken: "token",
        bootstrap: { configEpoch: "epoch-1", agents: [], toolCatalog: [] },
      },
      ipcAuthToken: "token",
      workerId: "worker-1",
      server: {
        useConnection() {
          throw new Error("connection closed");
        },
        notify() {
          expect.unreachable("bootstrap_ready should not be sent after activation fails");
        },
      },
      connectionId: "conn-1",
      respond: (result) => responses.push(result),
      state,
    });

    await expect(state.ready).rejects.toThrow("connection closed");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ ok: false, error: "connection closed" });
  });
});
