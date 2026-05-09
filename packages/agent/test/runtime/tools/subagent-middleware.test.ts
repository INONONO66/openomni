import { beforeAll, describe, expect, it, mock } from "bun:test";
import { AgentRegistry } from "../../../src/runtime/registry/registry";
import type { AgentProfile } from "@openomni/protocol";
import type { MiddlewareRegistration } from "../../../src/core/middleware";

let SubagentTool: typeof import("../../../src/runtime/tools/subagent").SubagentTool;

beforeAll(async () => {
  ({ SubagentTool } = await import("../../../src/runtime/tools/subagent"));
});

function makeDefinition(
  name: string,
  overrides: Partial<AgentProfile.Definition> = {},
): AgentProfile.Definition {
  return {
    name,
    description: `${name} agent`,
    tools: [],
    ...overrides,
  };
}

function resetState() {
  AgentRegistry.clear();
}

function makeMiddleware(name: string, propagate?: boolean): MiddlewareRegistration {
  return {
    name,
    timing: "pre_run",
    priority: 100,
    propagate,
    fn: async () => ({ action: "continue" as const }),
  };
}

function makeSpawn() {
  return mock(async () => ({ sessionId: "s", runId: "r", output: "ok" }));
}

describe("SubagentTool middleware propagation via SubagentRuntime", () => {
  it("forwards middleware with propagate=true to spawn", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("prop-true-agent"));
    const spawn = makeSpawn();
    const mw = makeMiddleware("tracked-mw", true);
    const { execute } = SubagentTool.create({
      middleware: [mw],
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "s", runId: "r", output: "o" })),
      },
    });

    await execute({ agentName: "prop-true-agent", prompt: "hello" });

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = spawnArg.middleware as MiddlewareRegistration[] | undefined;
    expect(middleware).toBeDefined();
    expect(middleware?.some((m) => m.name === "tracked-mw")).toBe(true);
  });

  it("blocks middleware with propagate=false from spawn", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("prop-false-agent"));
    const spawn = makeSpawn();
    const mw = makeMiddleware("blocked-mw", false);
    const { execute } = SubagentTool.create({
      middleware: [mw],
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "s", runId: "r", output: "o" })),
      },
    });

    await execute({ agentName: "prop-false-agent", prompt: "hello" });

    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = (spawnArg.middleware ?? []) as MiddlewareRegistration[];
    expect(middleware.some((m) => m.name === "blocked-mw")).toBe(false);
  });

  it("blocks middleware with no propagate field (default=false)", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("default-prop-agent"));
    const spawn = makeSpawn();
    const mw = makeMiddleware("no-field-mw");
    const { execute } = SubagentTool.create({
      middleware: [mw],
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "s", runId: "r", output: "o" })),
      },
    });

    await execute({ agentName: "default-prop-agent", prompt: "hello" });

    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = (spawnArg.middleware ?? []) as MiddlewareRegistration[];
    expect(middleware.some((m) => m.name === "no-field-mw")).toBe(false);
  });

  it("forwards only propagate=true entries when middleware is mixed", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("mixed-agent"));
    const spawn = makeSpawn();
    const propagated = makeMiddleware("propagated-mw", true);
    const blocked = makeMiddleware("blocked-mw", false);
    const { execute } = SubagentTool.create({
      middleware: [propagated, blocked],
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "s", runId: "r", output: "o" })),
      },
    });

    await execute({ agentName: "mixed-agent", prompt: "hello" });

    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = spawnArg.middleware as MiddlewareRegistration[] | undefined;
    expect(middleware).toBeDefined();
    expect(middleware?.some((m) => m.name === "propagated-mw")).toBe(true);
    expect(middleware?.some((m) => m.name === "blocked-mw")).toBe(false);
  });

  it("passes propagated middleware to send when continuing an existing session", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("session-mw-agent"));
    const send = mock(async () => ({ sessionId: "s", runId: "r", output: "ok" }));
    const mw = makeMiddleware("send-mw", true);
    const { execute } = SubagentTool.create({
      middleware: [mw],
      subagentRuntime: {
        spawn: mock(async () => ({ sessionId: "s", runId: "r", output: "ok" })),
        send,
      },
    });

    await execute({
      agentName: "session-mw-agent",
      prompt: "hello",
      sessionId: "existing-session",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sendArg = send.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = sendArg.middleware as MiddlewareRegistration[] | undefined;
    expect(middleware).toBeDefined();
    expect(middleware?.some((m) => m.name === "send-mw")).toBe(true);
  });
});
