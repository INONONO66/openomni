import {
  canonicalDigest,
  type LedgerAction,
  type PlainObject,
  type PlainValue,
} from "@openomni/protocol";
import type {
  ExecutionBatchResult,
  ExecutionRequest,
  ExecutorOptions,
  RecoveryClassification,
  RecoverySite,
} from "./executor-contract";
import type { createExecutionRecord } from "./executor-record";

type RecordPort = Pick<ReturnType<typeof createExecutionRecord>, "appendResult">;
type Proof = "absent" | "applied" | "indeterminate";

interface RecoveryVerdict {
  readonly terminal: "failed" | "outcome_unknown";
  readonly classification: RecoveryClassification;
  readonly proof: Proof;
  readonly proofReceipt: { readonly id: string; readonly digest: string } | null;
}

/** Kernel-local projections settle in the ledger transaction; everything else may have left the process. */
export function recoveryClassification(
  request: Pick<ExecutionRequest, "kind" | "recovery">,
): RecoveryClassification {
  if (request.recovery !== undefined) return request.recovery;
  return request.kind === "compaction" || request.kind === "message"
    ? "local_transactional"
    : "ambiguous_no_replay";
}

function object(value: PlainValue | undefined): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isClassification(value: PlainValue | undefined): value is RecoveryClassification {
  return (
    value === "local_transactional" ||
    value === "endpoint_idempotent" ||
    value === "read_back_reconcilable" ||
    value === "ambiguous_no_replay"
  );
}

/** The ledger itself is the read-back for a kernel-local transaction: no terminal means nothing happened. */
function localAbsent(receipt: LedgerAction.Node): RecoveryVerdict {
  return {
    terminal: "failed",
    classification: "local_transactional",
    proof: "absent",
    proofReceipt: { id: receipt.id, digest: canonicalDigest(receipt.effect.value) },
  };
}

/** Without external read-back, only an absent local transaction is decisive. */
function crashVerdict(action: LedgerAction.Node): RecoveryVerdict {
  const recorded = object(action.intent.value).recovery;
  const classification = isClassification(recorded)
    ? recorded
    : recoveryClassification({ kind: action.kind });
  if (classification === "local_transactional") return localAbsent(action);
  return {
    terminal: "outcome_unknown",
    classification,
    proof: "indeterminate",
    proofReceipt: null,
  };
}

/**
 * Recovery reads the original terminal slot first and never runs a body.
 * A refused recovery commit propagates: the durable intent stays recovery-pending.
 */
export function createExecutionRecovery(options: ExecutorOptions, record: RecordPort) {
  function actions(): readonly LedgerAction.Node[] {
    return options.ledger.actions?.() ?? [];
  }

  function terminal(intentId: string): LedgerAction.Node | undefined {
    return actions().find(
      (action) => action.parentId === intentId && object(action.effect.value).phase === "result",
    );
  }

  function projected(result: LedgerAction.Node, value: PlainValue): ExecutionBatchResult {
    const effect = object(result.effect.value);
    if (effect.terminal === "executed")
      return { terminal: "executed", value: effect.result ?? value };
    if (effect.terminal === "blocked_post")
      return {
        terminal: "blocked_post",
        disposition: effect.disposition === "reverted" ? "reverted" : "irreversible",
        reason: String(effect.reason),
      };
    return { terminal: "failed", error: new Error(String(effect.terminal)) };
  }

  /** The body settled in-process; only its completion failed. Known evidence is a failed completion, never a replay. */
  async function recoverCompletion(
    intentId: string,
    request: ExecutionRequest,
    site: RecoverySite,
    error: Error,
    value: PlainValue,
  ): Promise<ExecutionBatchResult> {
    const existing = terminal(intentId);
    if (existing !== undefined) return projected(existing, value);
    await record.appendResult(
      { kind: request.kind as LedgerAction.Kind, op: request.op },
      intentId,
      {
        phase: "result",
        terminal: "failed",
        disposition: "irreversible",
        effect: request.effect,
        resultHash: canonicalDigest(value),
        error: { name: error.name },
        ...(request.toolObservation ? { callId: request.toolObservation.callId } : {}),
        recovery: {
          site,
          classification: recoveryClassification(request),
          proof: "applied",
          proofReceipt: { id: intentId, digest: canonicalDigest(value) },
          revertReceipt: null,
          rawSettled: true,
        },
      },
    );
    return { terminal: "failed", error };
  }

  async function settleCrash(action: LedgerAction.Node, verdict: RecoveryVerdict): Promise<void> {
    const intent = object(action.intent.value);
    const callId = typeof intent.callId === "string" ? intent.callId : undefined;
    await record.appendResult({ kind: action.kind, op: String(intent.op) }, action.id, {
      phase: "result",
      terminal: verdict.terminal,
      effect: intent.effect ?? {},
      error: { name: "ProcessLost" },
      ...(callId === undefined ? {} : { callId }),
      ...(action.kind === "tool" && callId !== undefined
        ? {
            toolResult: {
              id: callId,
              toolCallId: callId,
              toolName: String(intent.op),
              output: `${String(intent.op)} outcome unknown: the process was lost before a result was recorded`,
              isError: true,
              settlement: verdict.terminal === "outcome_unknown" ? "unknown" : "settled",
            },
          }
        : {}),
      recovery: {
        site: "crash",
        classification: verdict.classification,
        proof: verdict.proof,
        proofReceipt: verdict.proofReceipt,
        revertReceipt: null,
        rawSettled: false,
      },
    });
  }

  function openIntents(all: readonly LedgerAction.Node[]): LedgerAction.Node[] {
    const turnId = options.identity.turnId ?? options.identity.parentActionId;
    const parents = new Set<string | null>([turnId]);
    const guardedWaves = new Set<PlainValue | undefined>();
    for (const action of all) {
      const intent = object(action.intent.value);
      if (action.kind === "turn" && intent.phase === "resume" && intent.turnId === turnId)
        parents.add(action.id);
      if (intent.approvalRequired === true) guardedWaves.add(intent.waveId);
    }
    return all.filter((action) => {
      const intent = object(action.intent.value);
      if (intent.phase !== "intent" || terminal(action.id) !== undefined) return false;
      if (action.kind === "tool")
        return intent.turnId === turnId && !guardedWaves.has(intent.waveId);
      return (
        (action.kind === "llm" || action.kind === "message" || action.kind === "compaction") &&
        parents.has(action.parentId)
      );
    });
  }

  /** Crash-open settlement for this turn: persisted evidence only, no body, guarded waves stay with their captured dispatcher. */
  async function recover(): Promise<void> {
    const all = actions();
    for (const action of openIntents(all)) {
      if (action.kind !== "llm") {
        await settleCrash(action, crashVerdict(action));
        continue;
      }
      // Provider attempts carry the external effect; an open one makes the
      // logical llm ambiguous, while settled attempts leave only the local commit.
      let ambiguous = false;
      let lastSettled: LedgerAction.Node = action;
      for (const attempt of all) {
        if (attempt.kind !== "attempt" || attempt.parentId !== action.id) continue;
        if (object(attempt.intent.value).phase !== "intent") continue;
        const settled = terminal(attempt.id);
        if (settled !== undefined) {
          lastSettled = settled;
          continue;
        }
        ambiguous = true;
        await settleCrash(attempt, crashVerdict(attempt));
      }
      await settleCrash(action, ambiguous ? crashVerdict(action) : localAbsent(lastSettled));
    }
  }

  return { recover, recoverCompletion };
}
