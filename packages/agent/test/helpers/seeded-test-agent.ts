import { testExecutor } from "./executor";
import {
  type ChatFixture as ChatAgentConfig,
  type ChatFixture,
  chatServices,
} from "./chat-services";
import {
  compilePolicySnapshot,
  KERNEL_POLICY_REGISTRY,
  SEEDED_POLICY_ROWS,
} from "@openomni/policy";
import { Effect } from "effect";
import type { Sink } from "@openomni/llm";
import type { ChatAgentInput } from "../../src/core/types";
import type { ExecutorOptions } from "../../src/executor-contract";
import { runAgent } from "../../src/core/execution/run";
import { recordingLedger } from "./recording-ledger";

/** Seeded-policy chat agent over the production executor; the retry alarm is the only fixture choice. */
export function seededTestAgent(retryAlarm: NonNullable<ExecutorOptions["retryAlarm"]>) {
  return (config: ChatAgentConfig) => ({
    run(input: ChatAgentInput, sink?: Sink) {
      const record = recordingLedger();
      const executor = testExecutor({
        policy: compilePolicySnapshot({
          registry: KERNEL_POLICY_REGISTRY,
          generation: 1,
          rows: SEEDED_POLICY_ROWS.map((row: (typeof SEEDED_POLICY_ROWS)[number]) => ({
            ...row,
            generation: 1,
          })),
        }),
        ledger: record.ledger,
        observations: config.events,
        signal: config.signal,
        clock: () => Date.now(),
        entropy: record.entropy,
        retryAlarm,
        identity: {
          sessionId: input.traceContext?.sessionId ?? "session",
          role: "resident",
          parentActionId: null,
        },
      });
      return Effect.gen(function* () {
        const fixture: ChatFixture = { executor, execution: executor, ...config };
        const { events: _events, llm: _llm, ...acquiredConfig } = fixture;
        return yield* runAgent(input, acquiredConfig, sink).pipe(
          Effect.provide(chatServices(fixture)),
        );
      });
    },
  });
}
