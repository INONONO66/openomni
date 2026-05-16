import { describe, expect, test } from "bun:test";
import { createMainWorkerTools } from "../../src/persona/main-worker-tools";

describe("createMainWorkerTools", () => {
  test("routes spawn_worker through ingress with main actor and new-worker target", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = createMainWorkerTools({
      defaultModel: { provider: "test", id: "fixture" },
      ingest: async (event) => {
        calls.push(event as Record<string, unknown>);
        return {
          mode: "direct",
          target: { kind: "new-worker" },
          sessionId: "worker-session-1",
          result: { output: "spawned", finishReason: "stop" },
        };
      },
    });

    const spawn = tools.find((tool) => tool.spec.name === "spawn_worker");
    if (!spawn) throw new Error("spawn_worker tool missing");

    const result = await spawn.execute({
      id: "call-1",
      tool: "spawn_worker",
      input: {
        prompt: "do the thing",
        sessionId: "main-session",
        callerAgentName: "main",
        workspaceRoot: "/repo",
      },
    });

    expect(result.output).toContain("worker-session-1");
    expect(calls).toHaveLength(1);
    const [event] = calls;
    expect(event?.meta && typeof event.meta === "object").toBe(true);
    expect(
      (event?.meta as { actor?: { role?: string }; target?: { kind?: string } }).actor?.role,
    ).toBe("main");
    expect((event?.meta as { target?: { kind?: string } }).target?.kind).toBe("new-worker");
    expect((event?.meta as { target?: { parentSessionId?: string } }).target?.parentSessionId).toBe(
      "main-session",
    );
    expect((event?.runtime as { background?: boolean }).background).toBe(true);
  });

  test("routes cancel_worker through ingress with main actor and worker target", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = createMainWorkerTools({
      defaultModel: { provider: "test", id: "fixture" },
      ingest: async (event) => {
        calls.push(event as Record<string, unknown>);
        return {
          mode: "direct",
          target: { kind: "worker", sessionId: "worker-session-1" },
          sessionId: "worker-session-1",
          result: { output: "cancelled", finishReason: "stop" },
        };
      },
    });

    const cancel = tools.find((tool) => tool.spec.name === "cancel_worker");
    if (!cancel) throw new Error("cancel_worker tool missing");

    const result = await cancel.execute({
      id: "call-2",
      tool: "cancel_worker",
      input: {
        workerSessionId: "worker-session-1",
        reason: "stop",
        sessionId: "main-session",
        callerAgentName: "main",
      },
    });

    expect(result.output).toContain("cancel-requested");
    expect(calls).toHaveLength(1);
    const [event] = calls;
    expect((event?.meta as { actor?: { role?: string } }).actor?.role).toBe("main");
    expect((event?.meta as { target?: { kind?: string; sessionId?: string } }).target).toEqual({
      kind: "worker",
      sessionId: "worker-session-1",
    });
  });
});

test("spawn_worker uses configured worker agent factory", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tools = createMainWorkerTools({
    defaultModel: { provider: "test", id: "fixture" },
    createWorkerAgent: ({ agentName }) => ({
      model: { provider: "test", id: "fixture" },
      systemPrompt: `worker:${agentName}`,
      tools: [{ name: "read", inputSchema: { type: "object" } }],
    }),
    ingest: async (event) => {
      calls.push(event as Record<string, unknown>);
      return {
        mode: "direct",
        target: { kind: "new-worker" },
        sessionId: "worker-session-2",
        result: { output: "spawned", finishReason: "stop" },
      };
    },
  });

  const spawn = tools.find((tool) => tool.spec.name === "spawn_worker");
  if (!spawn) throw new Error("spawn_worker tool missing");

  await spawn.execute({
    id: "call-worker-agent",
    tool: "spawn_worker",
    input: { prompt: "do it", agentName: "dev", callerAgentName: "main" },
  });

  expect((calls[0]?.agent as { systemPrompt?: string }).systemPrompt).toBe("worker:dev");
  expect((calls[0]?.agent as { tools?: unknown[] }).tools).toHaveLength(1);
});

test("worker control tools fail closed without explicit caller identity", async () => {
  const tools = createMainWorkerTools({
    defaultModel: { provider: "test", id: "fixture" },
    ingest: async () => {
      throw new Error("ingest should not be called");
    },
  });

  const spawn = tools.find((tool) => tool.spec.name === "spawn_worker");
  if (!spawn) throw new Error("spawn_worker tool missing");

  const result = await spawn.execute({
    id: "call-missing-caller",
    tool: "spawn_worker",
    input: { prompt: "do it" },
  });

  expect(result.isError).toBe(true);
  expect(result.output).toContain("explicit Main Persona caller");
});
