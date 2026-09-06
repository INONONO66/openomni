import { createTestAgent } from "../../helpers/test-agent";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Machine, Tool } from "@openomni/protocol";
import { Bus } from "../../../src/index";
import { createAssistantMessage } from "../../../src/core/message-factory";
import type { ChatAgentConfig, ChatAgentInput } from "../../../src/core/types";

const gatedTool: Tool.Spec = {
  name: "screen.capture",
  inputSchema: { type: "object" },
  placement: "machine",
  requires: ["screen.read"],
};
const freeTool: Tool.Spec = { name: "network.fetch", inputSchema: { type: "object" } };
const input: ChatAgentInput = {
  messages: [{ role: "user", content: "inspect" }],
  traceContext: {
    traceId: "trace-placement",
    sessionId: "session-placement",
    runId: "run-placement",
  },
};

async function exercise(
  options: {
    capabilities?: readonly Machine.CapabilityId[];
    call?: Tool.Call;
    tools?: Tool.Spec[];
    wave?: boolean;
  } = {},
) {
  const catalogs: string[][] = [];
  const executed: string[] = [];
  const results: Tool.Result[] = [];
  let requested = false;
  const body = async (call: Tool.Call): Promise<Tool.Result> => {
    executed.push(call.tool);
    return { id: call.id, toolCallId: call.id, output: "result" };
  };
  const config: ChatAgentConfig = {
    events: Bus,
    model: { provider: "test", id: "model" },
    tools: options.tools ?? [gatedTool, freeTool],
    toolTargets: [
      { kind: "host", capabilities: [] },
      { kind: "machine", id: "machine", capabilities: options.capabilities ?? [] },
    ],
    toolExecutor: body,
    ...(options.wave
      ? { toolWave: (calls: readonly Tool.Call[]) => Promise.all(calls.map(body)) }
      : {}),
    llm: {
      resolveModel: async () => ({ id: "model", name: "model", providerID: "test" }),
      run: async (modelInput, sink) => {
        catalogs.push(modelInput.tools.map((tool) => tool.name));
        const message = createAssistantMessage("placement completed", "", "session-placement");
        const call = options.call;
        if (!requested && call !== undefined) {
          requested = true;
          message.parts.push({
            id: "tool-part",
            messageID: message.info.id,
            sessionID: "session-placement",
            type: "tool",
            callID: call.id,
            tool: call.tool,
            state: { status: "pending", input: call.input },
          });
        }
        sink.onMessage(message);
        return { type: "stop" };
      },
    },
  };
  await createTestAgent(config).run(input, {
    onMessage: () => undefined,
    onToolCall: () => undefined,
    onToolResult: (result) => results.push(result),
  });
  return { catalogs, executed, results };
}

describe("agent tool placement catalog", () => {
  beforeEach(() => Bus.reset());
  it("offers only tools whose capability is held", async () => {
    expect((await exercise()).catalogs).toEqual([["network.fetch"]]);
    expect((await exercise({ capabilities: ["screen.read"] })).catalogs).toEqual([
      ["screen.capture", "network.fetch"],
    ]);
  });
  for (const wave of [false, true]) {
    for (const name of ["screen.capture", "screen_capture"]) {
      it(`refuses filtered ${name} at the ${wave ? "wave" : "single"} execution door`, async () => {
        const observed = await exercise({ wave, call: { id: "forged", tool: name, input: {} } });
        expect(observed.executed).toEqual([]);
        expect(observed.results).toMatchObject([
          { toolCallId: "forged", toolName: name, isError: true },
        ]);
      });
    }
    for (const tools of [
      [gatedTool, { name: "screen_capture", inputSchema: { type: "object" } }],
      [{ name: "screen_capture", inputSchema: { type: "object" } }, gatedTool],
    ]) {
      it(`refuses a colliding alias at the ${wave ? "wave" : "single"} door regardless of catalog order`, async () => {
        const observed = await exercise({
          wave,
          tools,
          call: { id: "collision", tool: "screen_capture", input: {} },
        });
        expect(observed.executed).toEqual([]);
        expect(observed.results).toMatchObject([{ toolCallId: "collision", isError: true }]);
      });
    }
    it(`leaves dynamic resolution and permitted calls to the ${wave ? "wave" : "single"} executor`, async () => {
      expect(
        (await exercise({ wave, call: { id: "dynamic", tool: "mcp.relay.thing", input: {} } }))
          .executed,
      ).toEqual(["mcp.relay.thing"]);
      const permitted = await exercise({
        wave,
        capabilities: ["screen.read"],
        call: { id: "real", tool: "screen.capture", input: {} },
      });
      expect(permitted.executed).toEqual(["screen.capture"]);
      expect(permitted.results).toMatchObject([{ toolCallId: "real", output: "result" }]);
    });
  }
});
