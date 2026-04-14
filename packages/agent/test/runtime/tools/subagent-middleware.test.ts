import { beforeAll, describe, expect, it, mock } from "bun:test";
import { AgentRegistry } from "../../../src/runtime/registry/registry";
import { Bus } from "@openomni/session";
import { AgentMessenger } from "../../../src/runtime/messenger/messenger";
import type { AgentProfile } from "@openomni/protocol";
import type { MiddlewareRegistration } from "../../../src/core/middleware/types";

let SubagentTool: typeof import("../../../src/runtime/tools/subagent").SubagentTool;
let mockChatAgentCreate: any;

mock.module("../../../src/core/chat-agent", () => ({
  ChatAgent: {
    create: (...args: unknown[]) => mockChatAgentCreate(...args),
  },
}));

beforeAll(async () => {
  mockChatAgentCreate = mock(() => ({
    run: mock(async () => ({ text: "ok", usage: undefined })),
  }));
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
  Bus.reset();
  AgentMessenger._resetLog();
  mockChatAgentCreate = mock(() => ({
    run: mock(async () => ({ text: "ok", usage: undefined })),
  }));
}

// propagate is not on MiddlewareRegistration yet — T8 will add it
type MiddlewareWithPropagate = MiddlewareRegistration & { propagate?: boolean };

function makeMiddleware(name: string, propagate?: boolean): MiddlewareWithPropagate {
  return {
    name,
    timing: "pre_turn",
    priority: 100,
    fn: async () => ({ action: "continue" as const }),
    ...(propagate !== undefined && { propagate }),
  };
}

describe("SubagentTool middleware propagation", () => {
  it("forwards middleware with propagate=true to child ChatAgent", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("prop-true-agent"));

    const mw = makeMiddleware("tracked-mw", true);
    // middleware option doesn't exist on SubagentToolOptions yet — T8 will add it
    const { execute } = (SubagentTool as any).create({ middleware: [mw] });

    await execute({ agentName: "prop-true-agent", prompt: "hello" });

    expect(mockChatAgentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: expect.arrayContaining([expect.objectContaining({ name: "tracked-mw" })]),
      }),
    );
  });

  it("blocks middleware with propagate=false from child ChatAgent", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("prop-false-agent"));

    const mw = makeMiddleware("blocked-mw", false);
    const { execute } = (SubagentTool as any).create({ middleware: [mw] });

    await execute({ agentName: "prop-false-agent", prompt: "hello" });

    const call = mockChatAgentCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = (call?.middleware ?? []) as MiddlewareWithPropagate[];
    expect(middleware.some((m) => m.name === "blocked-mw")).toBe(false);
  });

  it("blocks middleware with no propagate field (default=false)", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("default-prop-agent"));

    const mw = makeMiddleware("no-field-mw");
    const { execute } = (SubagentTool as any).create({ middleware: [mw] });

    await execute({ agentName: "default-prop-agent", prompt: "hello" });

    const call = mockChatAgentCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = (call?.middleware ?? []) as MiddlewareWithPropagate[];
    expect(middleware.some((m) => m.name === "no-field-mw")).toBe(false);
  });

  it("forwards only propagate=true entries when middleware is mixed", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("mixed-agent"));

    const propagated = makeMiddleware("propagated-mw", true);
    const blocked = makeMiddleware("blocked-mw", false);
    const { execute } = (SubagentTool as any).create({ middleware: [propagated, blocked] });

    await execute({ agentName: "mixed-agent", prompt: "hello" });

    expect(mockChatAgentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: expect.arrayContaining([expect.objectContaining({ name: "propagated-mw" })]),
      }),
    );

    const call = mockChatAgentCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = (call?.middleware ?? []) as MiddlewareWithPropagate[];
    expect(middleware.some((m) => m.name === "blocked-mw")).toBe(false);
  });

  it("does not pass middleware to subagentRuntime.spawn (runtime manages its own)", async () => {
    resetState();
    AgentRegistry.define(makeDefinition("runtime-mw-agent"));

    const spawn = mock(async () => ({
      sessionId: "session-x",
      runId: "run-x",
      output: "runtime output",
    }));

    const mw = makeMiddleware("runtime-excluded-mw", true);
    const { execute } = (SubagentTool as any).create({
      middleware: [mw],
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "unused", runId: "unused", output: "unused" })),
      },
    });

    await execute({ agentName: "runtime-mw-agent", prompt: "hello" });

    expect(mockChatAgentCreate).toHaveBeenCalledTimes(0);
    expect(spawn).toHaveBeenCalledTimes(1);

    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnArg).not.toHaveProperty("middleware");
  });
});
