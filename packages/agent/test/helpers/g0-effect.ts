import { testExecutor } from "./executor";
import { type ChatFixture as ChatAgentConfig, type ChatFixture, chatServices } from "./chat-services";
import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import { Effect } from "effect";
import { LedgerAction } from "@openomni/protocol";
import type { Sink } from "@openomni/llm";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import type { ExecutionLedger } from "../../src/executor-contract";
import type { ChatAgentInput } from "../../src/core/types";
import { runAgent } from "../../src/core/execution/run";
import { compiledPolicy, fixtureHashes } from "./compiled-policy";

/** Effect-native recording port; the production executor still owns all policy and execution. */
export function recordingLedger(committed: LedgerAction.Append[] = []) {
  let ordinal = 0;
  const ledger: ExecutionLedger = {
    commit: (action: LedgerAction.Append) =>
      Effect.sync(() => {
        committed.push(action);
        ordinal += 1;
        return {
          action: LedgerAction.Node.parse({ ...action, ordinal, ...fixtureHashes(ordinal) }),
          revision: ordinal,
        };
      }),
  };
  return { committed, ledger, entropy: () => `action-${ordinal + 1}` };
}

const immediateRetryAlarm = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};

export function recordingExecutor() {
  const record = recordingLedger();
  return {
    ...record,
    executor: testExecutor({
      policy: compiledPolicy(),
      ledger: record.ledger,
      retryAlarm: immediateRetryAlarm,
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: null },
      clock: () => 1,
      entropy: record.entropy,
    }),
  };
}

export function createTestAgent(config: ChatAgentConfig) {
  return {
    run(input: ChatAgentInput, sink?: Sink) {
      const record = recordingLedger();
      const executor = testExecutor({
        policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
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
        retryAlarm: immediateRetryAlarm,
        identity: {
          sessionId: input.traceContext?.sessionId ?? "session",
          role: "resident",
          parentActionId: null,
        },
      });
      return Effect.gen(function* () { const fixture: ChatFixture = { executor, execution: executor, ...config }; const { events: _events, llm: _llm, ...acquiredConfig } = fixture; return yield* runAgent(input, acquiredConfig, sink).pipe(Effect.provide(chatServices(fixture))); });
    },
  };
}

export function runTestAgent(input: ChatAgentInput, config: ChatAgentConfig, sink?: Sink) {
  return createTestAgent(config).run(input, sink);
}
