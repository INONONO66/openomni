import { Effect } from "effect";
import type { CommitFailed } from "./errors";
import {
  canonicalDigest,
  type LedgerAction,
  type PlainObject,
  type PlainValue,
} from "@openomni/protocol";
import type {
  ExecutionRequest,
  ExecutorOptions,
  RecoveryClassification,
} from "./executor-contract";
import type { createExecutionRecord } from "./executor-record";

type RecordPort = Pick<ReturnType<typeof createExecutionRecord>, "appendResult">;
type Proof = "absent" | "applied" | "indeterminate";

interface RecoveryVerdict {
  readonly terminal: "interrupted" | "outcome_unknown";
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

const classifications: readonly RecoveryClassification[] = [
  "local_transactional",
  "endpoint_idempotent",
  "read_back_reconcilable",
  "ambiguous_no_replay",
];

/** The classification the intent recorded, or undefined when it recorded none it can be held to. */
function recordedClassification(value: PlainValue | undefined): RecoveryClassification | undefined {
  return classifications.find((classification) => classification === value);
}

/** The ledger itself is the read-back for a kernel-local transaction: no terminal means nothing happened. */
function localAbsent(receipt: LedgerAction.Node): RecoveryVerdict {
  return {
    terminal: "interrupted",
    classification: "local_transactional",
    proof: "absent",
    proofReceipt: { id: receipt.id, digest: canonicalDigest(receipt.effect.value) },
  };
}

/** Without external read-back, only an absent local transaction is decisive. */
function crashVerdict(action: LedgerAction.Node): RecoveryVerdict {
  const classification =
    recordedClassification(object(action.intent.value).recovery) ??
    recoveryClassification({ kind: action.kind });
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
  function terminal(intentId: string): LedgerAction.Node | undefined {
    return options.ledger.resultFor?.(intentId);
  }

  function settleCrash(
    action: LedgerAction.Node,
    verdict: RecoveryVerdict,
  ): Effect.Effect<void, CommitFailed> {
    const intent = object(action.intent.value);
    const callId = typeof intent.callId === "string" ? intent.callId : undefined;
    return record.appendResult({ kind: action.kind, op: String(intent.op) }, action.id, {
      phase: "result",
      terminal: verdict.terminal,
      effect: intent.effect ?? {},
      evidence: {
        failures: [{ tag: "OutcomeUnknown", reason: "process_lost" }],
        defects: [],
        interrupted: false,
      },
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

  /** The committed boundary child, when the body's transaction landed before the crash. */
  function boundaryEvidence(intentId: string): LedgerAction.Node | undefined {
    const action = options.ledger.actionById?.(`${intentId}:boundary`);
    return action !== undefined && object(action.effect.value).phase === "boundary"
      ? action
      : undefined;
  }

  /** Settle the open intent as executed from its durable boundary, never re-running the body. */
  function settleFromBoundary(
    action: LedgerAction.Node,
    boundary: LedgerAction.Node,
  ): Effect.Effect<void, CommitFailed> {
    const intent = object(action.intent.value);
    const result = object(boundary.effect.value).result ?? null;
    const revert = object(result).revert;
    return record.appendResult(
      { kind: action.kind, op: String(intent.op) },
      action.id,
      {
        phase: "result",
        terminal: "executed",
        effect: intent.effect ?? {},
        resultHash: canonicalDigest(result),
        result,
        recovery: {
          site: "crash",
          classification: "local_transactional",
          proof: "applied",
          proofReceipt: { id: boundary.id, digest: canonicalDigest(boundary.effect.value) },
          revertReceipt: null,
          rawSettled: true,
        },
      },
      revert,
    );
  }

  /** An open attempt or an already visible prefix cannot be proven absent.
   * Only non-visible settled attempts leave a purely local commit to recover. */
  function settleLlm(action: LedgerAction.Node) {
    return Effect.gen(function* () {
      let ambiguous = false;
      let lastSettled: LedgerAction.Node = action;
      for (const attempt of operationRecords(options.ledger.operationChildrenPage, action.id)) {
        if (attempt.kind !== "attempt" || attempt.parentId !== action.id) continue;
        if (object(attempt.intent.value).phase !== "intent") continue;
        const settled = terminal(attempt.id);
        if (settled !== undefined) {
          lastSettled = settled;
          ambiguous ||= hasVisiblePrefix(settled);
          continue;
        }
        ambiguous = true;
        yield* settleCrash(attempt, crashVerdict(attempt));
      }
      yield* settleCrash(action, ambiguous ? crashVerdict(action) : localAbsent(lastSettled));
    });
  }

  /** Crash-open settlement for this turn: persisted evidence only, no body, guarded waves stay with their captured dispatcher. */
  function recover(): Effect.Effect<void, CommitFailed> {
    return Effect.gen(function* () {
      const turnId = options.identity.turnId ?? options.identity.parentActionId;
      if (turnId === null) return;
      for (const action of operationRecords(options.ledger.openOperationsPage, turnId)) {
        if (action.kind !== "llm") {
          const boundary = boundaryEvidence(action.id);
          if (boundary === undefined) yield* settleCrash(action, crashVerdict(action));
          else yield* settleFromBoundary(action, boundary);
          continue;
        }
        yield* settleLlm(action);
      }
    });
  }

  return { recover };
}

function hasVisiblePrefix(action: LedgerAction.Node): boolean {
  const evidence = object(object(action.effect.value).evidence);
  if (evidence.visibleOutput === true) return true;
  return Array.isArray(evidence.failures) &&
    evidence.failures.some((failure) => object(failure).visibleOutput === true);
}

function* operationRecords(
  read: ExecutorOptions["ledger"]["openOperationsPage"],
  id: string,
): Generator<LedgerAction.Node> {
  let cursor = 0;
  for (;;) {
    const page = read?.(id, cursor) ?? [];
    yield* page;
    if (page.length < 256) return;
    cursor = page.at(-1)?.ordinal ?? cursor;
  }
}
