import { createTestAgent } from "../../helpers/test-agent";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { Bus } from "../../../src/index";
import { createAssistantMessage } from "../../../src/core/message-factory";
import type { ChatAgentConfig } from "../../../src/core/types";

// Legacy protocol metadata must not become a second admission authority.
const tools: Tool.Spec[] = [
  { name: "screen.capture", inputSchema: { type: "object" }, placement: "machine", requires: ["screen.read"] },
  { name: "network.fetch", inputSchema: { type: "object" } },
];

describe("tool calls reach the executor without target gating", () => {
  beforeEach(() => Bus.reset());
  for (const wave of [false, true]) {
    it(`preserves the catalog and executor refusal at the ${wave ? "wave" : "single"} door`, async () => {
      const catalogs: string[][] = [];
      const executed: string[] = [];
      const results: Tool.Result[] = [];
      let requested = false;
      const execute = async (call: Tool.Call): Promise<Tool.Result> => {
        executed.push(call.tool);
        return { id: call.id, toolCallId: call.id, output: "policy denied", isError: true };
      };
      const config: ChatAgentConfig = {
        events: Bus,
        model: { provider: "test", id: "model" },
        tools,
        toolExecutor: execute,
        ...(wave ? { toolWave: (calls: readonly Tool.Call[]) => Promise.all(calls.map(execute)) } : {}),
        llm: {
          resolveModel: async () => ({ id: "model", name: "model", providerID: "test" }),
          run: async (input, sink) => {
            catalogs.push(input.tools.map((tool) => tool.name));
            const message = createAssistantMessage("completed", "", "session-tools");
            if (!requested) {
              requested = true;
              message.parts.push({ id: "part", messageID: message.info.id, sessionID: "session-tools", type: "tool", callID: "call", tool: "screen.capture", state: { status: "pending", input: {} } });
            }
            sink.onMessage(message);
            return { type: "stop" };
          },
        },
      };
      await createTestAgent(config).run({ messages: [{ role: "user", content: "inspect" }], traceContext: { traceId: "trace-tools", sessionId: "session-tools", runId: "run-tools" } }, {
        onMessage: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (result) => results.push(result),
      });
      expect(catalogs.length).toBeGreaterThan(0);
      expect(catalogs.every((catalog) => catalog.join(",") === "screen.capture,network.fetch")).toBe(true);
      expect(executed).toEqual(["screen.capture"]);
      expect(results).toMatchObject([{ toolCallId: "call", isError: true, output: "policy denied" }]);
    });
  }
});
