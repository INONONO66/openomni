import { expect, test } from "bun:test";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import { LedgerAction } from "@openomni/protocol";
import { createExecutor } from "../../../src/executor";
import { runAgent } from "../../../src/core/execution/run";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { recordingLedger } from "../../helpers/compiled-policy";
import { runInput } from "../../helpers/run-input";

test("the final result consumes the executor-transformed canonical assistant rather than raw provider text", async () => {
  const recording = recordingLedger();
  const executor = createExecutor({
    policy: compilePolicySnapshot({
      generation: 1,
      kinds: LedgerAction.Kind.options,
      rows: [
        ...SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
        {
          name: "redact-assistant",
          generation: 1,
          kind: "message",
          phase: "post",
          priority: 1000,
          match: { encodingVersion: 1, value: { op: "assistant" } },
          verdict: {
            encodingVersion: 1,
            value: {
              type: "transform",
              name: "redact",
              paths: ["result.parts"],
              replacement: [
                {
                  id: "redacted",
                  sessionID: "session",
                  messageID: "message",
                  type: "text",
                  text: "redacted",
                },
              ],
            },
          },
        },
      ],
    }),
    ledger: recording.ledger,
    observations: { publish: () => undefined },
    clock: () => 1,
    entropy: recording.entropy,
    identity: { sessionId: "session", role: "resident", parentActionId: "turn" },
  });
  const result = await runAgent(runInput([{ role: "user", content: "question" }]), {
    events: { publish: () => undefined },
    executor,
    execution: executor,
    model: { provider: "test", id: "test" },
    llm: {
      resolveModel: async () => ({ providerID: "test", id: "test", name: "test" }),
      run: async (_input, sink) => {
        sink.onMessage(createAssistantMessage("raw text", "", "session"));
        return { type: "stop" };
      },
    },
  });
  expect(result.text).toBe("redacted");
  expect(result.steps).toEqual([{ type: "text", content: "redacted" }]);
});
