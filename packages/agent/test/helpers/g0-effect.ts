import { Effect } from "effect";
import { LedgerAction } from "@openomni/protocol";
import type { Sink } from "@openomni/llm";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import { createExecutor } from "../../src/executor";
import type { ExecutionLedger } from "../../src/executor-contract";
import type { ChatAgentConfig, ChatAgentInput } from "../../src/core/types";
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

export const immediateRetryAlarm = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};

export function recordingExecutor() {
  const record = recordingLedger();
  return {
    ...record,
    executor: createExecutor({
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
      const executor = createExecutor({
        policy: compilePolicySnapshot({
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
      return runAgent(input, { executor, execution: executor, ...config }, sink);
    },
  };
}

export function runTestAgent(input: ChatAgentInput, config: ChatAgentConfig, sink?: Sink) {
  return createTestAgent(config).run(input, sink);
}
