import { createTestAgent } from "../../helpers/test-agent";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { Bus, createDispatcher, defineTool } from "../../../src/index";
import { compiledPolicy, recordingExecutor } from "../../helpers/compiled-policy";
import { z } from "zod";
import { createAssistantMessage } from "../../../src/core/message-factory";
import type { ChatAgentConfig } from "../../../src/core/types";

// Catalog metadata does not bypass the executor's compiled policy.
const tools: Tool.Spec[] = [
  {
    name: "screen.capture",
    inputSchema: { type: "object" },
    placement: "machine",
    requires: ["screen.read"],
  },
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
      const recording = recordingExecutor({
        policy: compiledPolicy([
          {
            name: "refuse-screen",
            kind: "tool",
            phase: "pre",
            priority: 1,
            generation: 1,
            match: { encodingVersion: 1, value: { op: "screen.capture" } },
            verdict: { encodingVersion: 1, value: { type: "deny", reason: "policy_denied" } },
          },
        ]),
      });
      const dispatcher = createDispatcher(
        [
          defineTool({
            name: "screen.capture",
            description: "Capture screen",
            category: "query",
            input: z.object({}),
            output: z.string(),
            visibility: { model: ["resident"], cell: [] },
            execute: async () => {
              executed.push("screen.capture");
              return "image";
            },
            render: (_input, output) => output,
          }),
        ],
        { executor: recording.executor },
      );
      const context = { sessionId: "session-tools", turnId: "turn-tools" };
      const execute = (call: Tool.Call) => dispatcher.execute(call, context);
      const config: ChatAgentConfig = {
        events: Bus,
        model: { provider: "test", id: "model" },
        tools,
        toolExecutor: execute,
        ...(wave
          ? { toolWave: (calls: readonly Tool.Call[]) => dispatcher.executeWave(calls, context) }
          : {}),
        llm: {
          resolveModel: async () => ({ id: "model", name: "model", providerID: "test" }),
          run: async (input, sink) => {
            catalogs.push(input.tools.map((tool) => tool.name));
            const message = createAssistantMessage("completed", "", "session-tools");
            if (!requested) {
              requested = true;
              message.parts.push({
                id: "part",
                messageID: message.info.id,
                sessionID: "session-tools",
                type: "tool",
                callID: "call",
                tool: "screen.capture",
                state: { status: "pending", input: {} },
              });
            }
            sink.onMessage(message);
            return { type: "stop" };
          },
        },
      };
      await createTestAgent(config).run(
        {
          messages: [{ role: "user", content: "inspect" }],
          traceContext: { traceId: "trace-tools", sessionId: "session-tools", runId: "run-tools" },
        },
        {
          onMessage: () => undefined,
          onToolCall: () => undefined,
          onToolResult: (result) => results.push(result),
        },
      );
      expect(catalogs.length).toBeGreaterThan(0);
      expect(
        catalogs.every((catalog) => catalog.join(",") === "screen.capture,network.fetch"),
      ).toBe(true);
      expect(executed).toEqual([]);
      expect(results).toMatchObject([
        { toolCallId: "call", isError: true, errorKind: "precondition_failed" },
      ]);
      expect(
        recording.committed
          .filter((action) => action.kind === "policy.decision")
          .map((action) => action.intent.value),
      ).toContainEqual(
        expect.objectContaining({
          hook: "tool.pre",
          op: "screen.capture",
          verdict: "deny",
          matchedRuleIds: ["refuse-screen"],
        }),
      );
    });
  }
});
