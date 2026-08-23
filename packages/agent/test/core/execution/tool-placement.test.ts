import { beforeEach, describe, expect, it } from "bun:test";
import type { RunInput } from "@openomni/llm";
import type { Machine, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { ChatAgent } from "../../../src/core/chat-agent";
import type { ChatAgentConfig, ChatAgentInput } from "../../../src/core/types";

const gatedTool: Tool.Spec = {
  name: "screen.capture",
  inputSchema: { type: "object" },
  placement: "machine",
  requires: ["screen.read"],
};
const freeTool: Tool.Spec = {
  name: "network.fetch",
  inputSchema: { type: "object" },
};
const input: ChatAgentInput = {
  messages: [{ role: "user", content: "inspect" }],
  traceContext: {
    traceId: "trace-placement",
    sessionId: "session-placement",
    runId: "run-placement",
  },
};

function config(
  machineCapabilities: readonly Machine.CapabilityId[],
  catalogs: string[][],
  executed: string[] = [],
  forge?: (input: RunInput) => Promise<unknown>,
): ChatAgentConfig {
  return {
    events: Bus,
    model: { provider: "test", id: "test-model" },
    tools: [gatedTool, freeTool],
    toolTargets: [
      { kind: "host", capabilities: [] },
      { kind: "machine", id: "attached-machine", capabilities: machineCapabilities },
    ],
    toolExecutor: async (call) => {
      executed.push(call.tool);
      return { id: "result-unused", toolCallId: call.id, output: "unused" };
    },
    llm: {
      resolveProviderModel: async () => ({
        id: "test-model",
        name: "Test Model",
        providerID: "test",
      }),
      run: async (runInput: RunInput) => {
        catalogs.push(runInput.tools.map((tool) => tool.name));
        if (forge !== undefined) await forge(runInput);
        return { type: "stop" };
      },
    },
  };
}

describe("agent tool placement catalog", () => {
  beforeEach(() => Bus.reset());

  it("hands the llm only tools whose required capability is held", async () => {
    const withoutCapability: string[][] = [];
    await ChatAgent.create(config([], withoutCapability)).run(input);

    const withCapability: string[][] = [];
    await ChatAgent.create(config(["screen.read"], withCapability)).run(input);

    expect(withoutCapability).toEqual([["network.fetch"]]);
    expect(withCapability).toEqual([["screen.capture", "network.fetch"]]);
  });

  it("refuses a forged call to a filtered tool instead of executing it", async () => {
    const executed: string[] = [];
    let refusal: Tool.Result | undefined;
    await ChatAgent.create(
      config([], [], executed, async (runInput) => {
        refusal = await runInput.toolExecutor?.(
          { id: "forged", tool: gatedTool.name, input: {} },
          { signal: new AbortController().signal },
        );
      }),
    ).run(input);

    expect(executed).toEqual([]);
    expect(refusal).toMatchObject({
      toolCallId: "forged",
      toolName: gatedTool.name,
      isError: true,
      output: 'tool "screen.capture" requires capabilities no attached target holds: screen.read',
    });
  });

  it("refuses the underscore alias executors register for a filtered dotted tool", async () => {
    const executed: string[] = [];
    let refusal: Tool.Result | undefined;
    await ChatAgent.create(
      config([], [], executed, async (runInput) => {
        refusal = await runInput.toolExecutor?.(
          { id: "forged", tool: "screen_capture", input: {} },
          { signal: new AbortController().signal },
        );
      }),
    ).run(input);

    expect(executed).toEqual([]);
    expect(refusal).toMatchObject({
      toolCallId: "forged",
      toolName: "screen_capture",
      isError: true,
      output: 'tool "screen_capture" requires capabilities no attached target holds: screen.read',
    });
  });

  it("leaves an unrelated dynamic name to the tool executor", async () => {
    const executed: string[] = [];
    await ChatAgent.create(
      config([], [], executed, async (runInput) => {
        await runInput.toolExecutor?.(
          { id: "dynamic", tool: "mcp.relay.thing", input: {} },
          { signal: new AbortController().signal },
        );
      }),
    ).run(input);

    expect(executed).toEqual(["mcp.relay.thing"]);
  });

  it("still executes an offerable tool through the placement gate", async () => {
    const executed: string[] = [];
    let allowed: Tool.Result | undefined;
    await ChatAgent.create(
      config(["screen.read"], [], executed, async (runInput) => {
        allowed = await runInput.toolExecutor?.(
          { id: "real", tool: gatedTool.name, input: {} },
          { signal: new AbortController().signal },
        );
      }),
    ).run(input);

    expect(executed).toEqual([gatedTool.name]);
    expect(allowed).toMatchObject({ toolCallId: "real", output: "unused" });
  });
});
