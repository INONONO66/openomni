import type { ResolvedExecutorOptions } from "../../src/executor-contract";
import { executorLayer } from "./service-layers";
import type { LedgerError } from "@openomni/ledger";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import { LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import { createExecutor } from "../../src/executor";
import { compiledPolicy, fixtureHashes } from "./compiled-policy";

/** Commit gates and refusals happen before persistence, as in the real ledger. */
export function recoveryRecording(options: {
  readonly policy?: CompiledPolicySnapshot;
  readonly beforeCommit?: (action: LedgerAction.Append) => Effect.Effect<void, LedgerError>;
} = {}) {
  const committed: LedgerAction.Node[] = [];
  let sequence = 0;
  const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
    policy: options.policy ?? compiledPolicy(),
    ledger: {
      actions: () => committed,
      commit: (action) => Effect.gen(function* () {
        yield* options.beforeCommit?.(action) ?? Effect.void;
        const ordinal = committed.length + 1;
        const node = LedgerAction.Node.parse({ ...action, ordinal, ...fixtureHashes(ordinal) });
        committed.push(node);
        return { action: node, revision: ordinal };
      }),
    },
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: () => 1,
    entropy: () => `action-${++sequence}`,
  }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
  return { executor, committed };
}
