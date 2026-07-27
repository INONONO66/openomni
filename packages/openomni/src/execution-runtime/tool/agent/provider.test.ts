import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createWorkspaceIdentity } from "../../workspace-identity.js";
import type { NativeTool } from "../types.js";
import { AgentToolProvider, type AgentToolProviderOptions } from "./provider.js";

function makeCall(tool: string): Tool.Call {
  return { id: "call-1", tool, input: {} };
}

function makeDispatchCall(workspaceRoot?: string): Tool.Call {
  return {
    id: "call-dispatch",
    tool: "dispatch",
    input: {
      action: "system.test",
      target: { kind: "system" },
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    },
  };
}

function makeTool(name: string): NativeTool {
  return {
    spec: { name, inputSchema: { type: "object", properties: {} } },
    riskTier: 0,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    source: "agent",
    execute: async (call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: `${name}-result`,
    }),
  };
}

const dispatchWorkspaceRoots: Array<string | undefined> = [];
let testDir: string;
let providerOptions: AgentToolProviderOptions;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "openomni-agent-provider-"));
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error("unused AgentToolProvider test dependency"));
  providerOptions = {
    workspaceIdentity: createWorkspaceIdentity(testDir),
    dispatchRuntime: {
      async submit(_input, options) {
        dispatchWorkspaceRoots.push(options?.workspaceRoot);
        return { dispatchId: crypto.randomUUID(), status: "completed" };
      },
    },
    waitKernel: {
      correlate: unavailable,
      revalidatePinned: unavailable,
      acceptResponse: unavailable,
      settle: unavailable,
      cancel: unavailable,
      stageAmbiguity: unavailable,
      markRouted: unavailable,
    },
    effects: {
      appendIntent: unavailable,
      appendSettlement: unavailable,
    },
    scheduleService: {
      create: unavailable,
      cancel: unavailable,
    },
    workerAttempts: {
      commands: {
        requestStart: unavailable,
        finish: unavailable,
        requestDelivery: unavailable,
        settleDelivery: unavailable,
        requestCancel: unavailable,
        settleCancel: unavailable,
      },
      queries: {
        byExecution: unavailable,
        active: unavailable,
      },
    },
    workerLedger: {
      commitSemanticTransition: unavailable,
      resolveWorkByRunId: unavailable,
      resolveAttemptByRunId: unavailable,
    },
    authorityQueries: { query: unavailable },
    owners: {},
  };
});

beforeEach(() => {
  dispatchWorkspaceRoots.length = 0;
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("AgentToolProvider", () => {
  it("includes the built-in dispatch tool", () => {
    const provider = new AgentToolProvider(providerOptions);
    const tools = provider.listTools();

    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.spec.name === "dispatch")).toBe(true);
  });

  it("register appends an extra tool to the list", () => {
    const provider = new AgentToolProvider(providerOptions);
    provider.register(makeTool("my-agent-tool"));

    const tools = provider.listTools();

    expect(tools.some((t) => t.spec.name === "my-agent-tool")).toBe(true);
  });

  it("name and category metadata are correct", () => {
    const provider = new AgentToolProvider(providerOptions);

    expect(provider.name).toBe("agent");
    expect(provider.category).toBe("agent");
  });

  it("execute returns error for unknown tool", async () => {
    const provider = new AgentToolProvider(providerOptions);

    const result = await provider.execute(makeCall("nonexistent"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool: nonexistent");
  });

  it("execute dispatches to a registered tool", async () => {
    const provider = new AgentToolProvider(providerOptions);
    provider.register(makeTool("helper-agent"));

    const result = await provider.execute(makeCall("helper-agent"));

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("helper-agent-result");
  });

  it("execute forwards execution context to registered tools", async () => {
    const provider = new AgentToolProvider(providerOptions);
    let capturedSignal: AbortSignal | undefined;
    provider.register({
      ...makeTool("helper-agent"),
      execute: async (call, context) => {
        capturedSignal = context?.signal;
        return { id: crypto.randomUUID(), toolCallId: call.id, output: "ok" };
      },
    });
    const controller = new AbortController();

    const result = await provider.execute(makeCall("helper-agent"), { signal: controller.signal });

    expect(result.output).toBe("ok");
    expect(capturedSignal).toBe(controller.signal);
  });

  it("execute dispatches only the exact registered Tool.Spec.name", async () => {
    const provider = new AgentToolProvider(providerOptions);
    provider.register(makeTool("my.agent.tool"));

    const aliasResult = await provider.execute(makeCall("my_agent_tool"));
    const exactResult = await provider.execute(makeCall("my.agent.tool"));

    expect(aliasResult.isError).toBe(true);
    expect(aliasResult.output).toContain("Unknown tool: my_agent_tool");
    expect(exactResult.isError).toBeUndefined();
    expect(exactResult.output).toBe("my.agent.tool-result");
  });

  it("binds dispatch to the provisioned workspace when the call omits a root", async () => {
    const provider = new AgentToolProvider(providerOptions);

    const result = await provider.execute(makeDispatchCall());

    expect(result.isError).toBeUndefined();
    expect(dispatchWorkspaceRoots).toEqual([providerOptions.workspaceIdentity.canonicalRoot]);
  });

  it("fails closed when a dispatch call supplies a mismatched workspace root", async () => {
    const provider = new AgentToolProvider(providerOptions);

    const result = await provider.execute(makeDispatchCall(join(testDir, "other")));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("dispatch workspace does not match provisioned identity");
    expect(dispatchWorkspaceRoots).toHaveLength(0);
  });

  it("fails closed when the provisioned workspace identity is missing", () => {
    expect(
      () =>
        new AgentToolProvider({
          ...providerOptions,
          workspaceIdentity: undefined as never,
        }),
    ).toThrow();
  });
});
