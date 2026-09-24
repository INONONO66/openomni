import { testExecutor } from "../../helpers/executor";
import { type ChatFixture, chatServices } from "../../helpers/chat-services";
import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import type { RunInput, Sink } from "@openomni/llm";
import { Effect } from "effect";
import { isolated } from "../../helpers/isolated";
import { expect, test } from "bun:test";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import { LedgerAction } from "@openomni/protocol";
import { runAgent } from "../../../src/core/execution/run";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { recordingLedger } from "../../helpers/g0-effect";
import { runInput } from "../../helpers/run-input";

test("the final result consumes the executor-transformed canonical assistant rather than raw provider text", async () => {
  const recording = recordingLedger();
  const executor = testExecutor({
    policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      kinds: LedgerAction.Kind.options,
      rows: [
        ...SEEDED_POLICY_ROWS.map((row: (typeof SEEDED_POLICY_ROWS)[number]) => ({
          ...row,
          generation: 1,
        })),
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
  const result = await isolated(
    Effect.gen(function* () { const fixture: ChatFixture = {
      events: { publish: () => undefined },
      executor,
      execution: executor,
      model: { provider: "test", id: "test" },
      llm: {
        resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
        run: (_input: RunInput, sink: Sink) =>
          Effect.sync(() => {
            sink.onMessage(createAssistantMessage("raw text", "", "session"));
            return { type: "stop" as const };
          }),
      },
    }; const { events: _events, llm: _llm, ...acquiredConfig } = fixture; return yield* runAgent(runInput([{ role: "user", content: "question" }]), acquiredConfig).pipe(Effect.provide(chatServices(fixture))); }),
  );
  expect(result.text).toBe("redacted");
  expect(result.steps).toEqual([{ type: "text", content: "redacted" }]);
});
