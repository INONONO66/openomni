import { compilePolicySnapshot, type CompiledPolicySnapshot } from "@openomni/policy";
import { LedgerAction, type PolicyRow } from "@openomni/protocol";
import { createExecutor, type Executor } from "../../src/index";

const mandatoryPolicyRow: PolicyRow.Row = {
  name: "compaction",
  kind: "turn",
  phase: "post",
  match: { encodingVersion: 1, value: { op: "compaction" } },
  verdict: { encodingVersion: 1, value: { type: "allow" } },
  priority: 1000,
  generation: 1,
};

/** A compiled test policy with the mandatory row plus the supplied behavior rows. */
export function compiledPolicy(rows: readonly PolicyRow.Row[] = []): CompiledPolicySnapshot {
  return compilePolicySnapshot({ generation: 1, mandatory: [], rows: [mandatoryPolicyRow, ...rows] });
}

/** An "allow everything" compiled policy for tests. */
export const allowAllPolicy = compiledPolicy();

/** Read the executor's nested operation and phase fields from an action append. */
export function opPhaseOf(action: LedgerAction.Append): string {
  for (const carrier of [action.intent?.value, action.effect?.value]) {
    if (carrier === null || typeof carrier !== "object" || Array.isArray(carrier)) continue;
    const { op, phase } = carrier;
    if (typeof op === "string" && typeof phase === "string") return `${op}:${phase}`;
  }
  return "unmatched";
}

/** An in-memory ExecutionLedger that records every append and mints ordinals. */
export function recordingLedger(committed: LedgerAction.Append[] = []) {
  let ordinal = 0;
  return {
    committed,
    entropy: () => `action-${ordinal + 1}`,
    ledger: {
      async commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt> {
        committed.push(action);
        ordinal += 1;
        return { action: LedgerAction.Node.parse({ ...action, ordinal }), revision: ordinal };
      },
    },
  };
}

interface RecordingExecutorOptions {
  readonly policy?: CompiledPolicySnapshot;
  readonly onCommit?: (action: LedgerAction.Append) => void | Promise<void>;
  readonly onObservation?: (name: string) => void;
  readonly clock?: () => number;
}

/** Production executor composition with deterministic in-memory commits and observation taps. */
export function recordingExecutor(options: RecordingExecutorOptions = {}): {
  readonly committed: LedgerAction.Append[];
  readonly executor: Executor;
} {
  const committed: LedgerAction.Append[] = [];
  let ordinal = 0;
  const executor = createExecutor({
    policy: options.policy ?? allowAllPolicy,
    ledger: {
      async commit(action) {
        committed.push(action);
        await options.onCommit?.(action);
        ordinal += 1;
        return { action: LedgerAction.Node.parse({ ...action, ordinal }), revision: ordinal };
      },
    },
    observations: { publish: (event) => options.onObservation?.(event.name) },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: options.clock ?? (() => 1),
    entropy: () => `action-${committed.length + 1}`,
  });
  return { committed, executor };
}


/** A manually released commit boundary for deterministic record-before-publish tests. */
export function actionCommitGate(expectedOpPhase: string): {
  readonly reached: Promise<void>;
  readonly release: () => void;
  readonly onCommit: (action: LedgerAction.Append) => Promise<void>;
} {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: release.resolve,
    async onCommit(action) {
      if (opPhaseOf(action) !== expectedOpPhase) return;
      reached.resolve();
      await release.promise;
    },
  };
}


/** Records only tool lifecycle names while allowing exact-event test signals. */
export function recordingToolObservations(onToolEvent?: (name: string) => void): {
  readonly names: string[];
  readonly observe: (name: string) => void;
} {
  const names: string[] = [];
  return {
    names,
    observe(name) {
      if (!name.startsWith("tool.execution.")) return;
      names.push(name);
      onToolEvent?.(name);
    },
  };
}
