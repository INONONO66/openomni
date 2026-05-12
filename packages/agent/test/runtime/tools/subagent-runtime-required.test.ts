import { beforeAll, describe, expect, it, mock } from "bun:test";
import { AgentRegistry } from "../../../src/runtime/registry/registry";
import type { AgentProfile } from "@openomni/protocol";
import type { PolicyRegistration } from "../../../src/core/policy/types";

let SubagentTool: typeof import("../../../src/runtime/tools/subagent").SubagentTool;
let mockChatAgentCreate: (...args: unknown[]) => unknown;

mock.module("../../../src/core/chat-agent", () => ({
  ChatAgent: {
    create: (...args: unknown[]) => mockChatAgentCreate(...args),
  },
}));

beforeAll(async () => {
  mockChatAgentCreate = mock(() => ({
    run: mock(async () => ({ text: "", usage: undefined })),
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
  mockChatAgentCreate = mock(() => ({
    run: mock(async () => ({ text: "", usage: undefined })),
  }));
}

function makeMiddleware(name: string, propagate?: boolean): PolicyRegistration {
  return {
    name,
    timing: "pre_run",
    priority: 100,
    propagate,
    fn: async () => ({ action: "continue" as const }),
  };
}

describe("SubagentTool SubagentRuntime execution", () => {
  it("calls spawn with agentName and prompt when subagentRuntime is provided", async () => {
    resetState();
    const spawn = mock(async () => ({
      sessionId: "s1",
      runId: "r1",
      output: "done",
    }));
    AgentRegistry.define(makeDefinition("runtime-agent"));
    const { execute } = SubagentTool.create({
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "s", runId: "r", output: "o" })),
      },
    });

    await execute({ agentName: "runtime-agent", prompt: "do the thing" });

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnArg.agentName).toBe("runtime-agent");
    expect(spawnArg.prompt).toBe("do the thing");
  });

  it("passes propagate=true middleware to spawn config", async () => {
    resetState();
    const spawn = mock(async () => ({
      sessionId: "s2",
      runId: "r2",
      output: "done",
    }));
    AgentRegistry.define(makeDefinition("mw-runtime-agent"));
    const mw = makeMiddleware("tracked-mw", true);
    const { execute } = SubagentTool.create({
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "s", runId: "r", output: "o" })),
      },
      middleware: [mw],
    });

    await execute({ agentName: "mw-runtime-agent", prompt: "hello" });

    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = spawnArg.middleware as PolicyRegistration[] | undefined;
    expect(middleware).toBeDefined();
    expect(middleware?.some((m) => m.name === "tracked-mw")).toBe(true);
  });

  it("forwards only propagate=true middleware to spawn", async () => {
    resetState();
    const spawn = mock(async () => ({
      sessionId: "s3",
      runId: "r3",
      output: "done",
    }));
    AgentRegistry.define(makeDefinition("propagate-filter-agent"));
    const propagated = makeMiddleware("will-forward", true);
    const blocked = makeMiddleware("will-block", false);
    const { execute } = SubagentTool.create({
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "s", runId: "r", output: "o" })),
      },
      middleware: [propagated, blocked],
    });

    await execute({ agentName: "propagate-filter-agent", prompt: "hello" });

    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = spawnArg.middleware as PolicyRegistration[] | undefined;
    expect(middleware).toBeDefined();
    expect(middleware?.some((m) => m.name === "will-forward")).toBe(true);
    expect(middleware?.some((m) => m.name === "will-block")).toBe(false);
  });

  it("does not include propagate=false middleware in spawn config", async () => {
    resetState();
    const spawn = mock(async () => ({
      sessionId: "s4",
      runId: "r4",
      output: "done",
    }));
    AgentRegistry.define(makeDefinition("no-propagate-agent"));
    const mw = makeMiddleware("blocked-mw", false);
    const { execute } = SubagentTool.create({
      subagentRuntime: {
        spawn,
        send: mock(async () => ({ sessionId: "s", runId: "r", output: "o" })),
      },
      middleware: [mw],
    });

    await execute({ agentName: "no-propagate-agent", prompt: "hello" });

    const spawnArg = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    const middleware = (spawnArg.middleware ?? []) as PolicyRegistration[];
    expect(middleware.some((m) => m.name === "blocked-mw")).toBe(false);
  });
});
