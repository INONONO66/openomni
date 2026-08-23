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
): ChatAgentConfig {
  return {
    events: Bus,
    model: { provider: "test", id: "test-model" },
    tools: [gatedTool, freeTool],
    toolTargets: [
      { kind: "host", capabilities: [] },
      { kind: "machine", id: "attached-machine", capabilities: machineCapabilities },
    ],
    toolExecutor: async (call) => ({
      id: "result-unused",
      toolCallId: call.id,
      output: "unused",
    }),
    llm: {
      resolveProviderModel: async () => ({
        id: "test-model",
        name: "Test Model",
        providerID: "test",
      }),
      run: async (runInput: RunInput) => {
        catalogs.push(runInput.tools.map((tool) => tool.name));
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
});
