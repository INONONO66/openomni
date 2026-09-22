import { Effect } from "effect";
import { LedgerAction } from "@openomni/protocol";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import { createExecutor } from "../../src/executor";
import { allowAllPolicy, fixtureHashes } from "./compiled-policy";

export function recordingLedger(committed: LedgerAction.Append[] = []) {
  let ordinal = 0;
  return {
    committed,
    entropy: () => `action-${ordinal + 1}`,
    ledger: {
      commit: (action: LedgerAction.Append) => Effect.sync(() => {
        committed.push(action); ordinal += 1;
        return { action: LedgerAction.Node.parse({ ...action, ordinal, ...fixtureHashes(ordinal) }), revision: ordinal };
      }),
    },
  };
}
export function recordingExecutor(options: { readonly policy?: CompiledPolicySnapshot; readonly onCommit?: (action: LedgerAction.Append) => void | Promise<void>; readonly onObservation?: (name: string) => void; readonly clock?: () => number } = {}) {
  const record = recordingLedger();
  const executor = createExecutor({
    closeGraceMs: 0,
    policy: options.policy ?? allowAllPolicy,
    retryAlarm: { arm: () => Effect.void, wait: () => Effect.void, settle: () => Effect.void },
    ledger: { commit: (action: LedgerAction.Append) => record.ledger.commit(action).pipe(Effect.tap(() => Effect.promise(async () => { await options.onCommit?.(action); }))) },
    observations: { publish: (event) => options.onObservation?.(event.name) },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null }, clock: options.clock ?? (() => 1), entropy: record.entropy,
  });
  return { ...record, executor };
}
