import {
  canonicalDigest,
  type GateDecision,
  type PlainValue,
  type PolicyTransform,
  type Policy,
  type PolicyRow,
  type RowVerdict,
} from "@openomni/protocol";
import type { Effect } from "effect";
import type { z } from "zod";
import { clonePlain, type MessagePolicyContext } from "./match";
import type { GatePointTable } from "../points";
import type { GateHandler, PendingConsult, PreparedResults } from "./compose";
import { legacyPointOf } from "./migrate";
import type { CompileErrorData, CompiledRow, PolicyCompileError } from "./row-parse";
import type { ProjectedGeneration } from "./project";

/**
 * Compatibility formatting (#1251): the public `PolicyEvaluation` shape, the
 * evaluator that runs one input through the projected gate and formats its
 * decision back into that legacy shape, and the fail-closed snapshot for
 * generations that refused to compile.
 */

export interface PolicyEvaluationInput {
  readonly kind: string;
  readonly phase: PolicyRow.Phase;
  readonly op?: string;
  readonly role?: "resident" | "child";
  readonly sessionId?: string;
  readonly message?: MessagePolicyContext;
  readonly value: PlainValue;
  /**
   * A previously committed gate decision for this input (#1251 r3): the gate
   * replays it verbatim — recorded responses included — without invoking
   * handlers. Excluded from the evaluation's input identity.
   */
  readonly recorded?: GateDecision;
}

interface CompiledObligation {
  readonly ref: string;
  readonly metric: Extract<RowVerdict, { type: "obligation" }>["metric"];
  readonly limit: number;
}

type EffectiveRowVerdict = "allow" | "deny" | "require_approval" | "transform" | "obligation";

export interface PolicyEvaluation {
  readonly generation: number;
  readonly snapshotHash: string;
  readonly inputHash: string;
  readonly matchedRuleIds: readonly string[];
  readonly transforms: readonly PolicyTransform[];
  readonly ref?: string;
  readonly verdict: EffectiveRowVerdict;
  readonly reason?: string;
  readonly value: PlainValue;
  readonly effects: readonly Policy.PolicyEffect[];
  readonly obligations: readonly CompiledObligation[];
  /** The gate's replayable decision: recorded responses, rewrite output, facts. */
  readonly gate?: GateDecision;
  /** True when `recorded` was replayed verbatim instead of re-evaluated. */
  readonly replayed?: boolean;
  readonly error?: Readonly<z.infer<typeof CompileErrorData>>;
}

export interface CompiledPolicySnapshot {
  readonly generation: number;
  readonly contentHash: string;
  /** The merged point registration table this snapshot compiled against (#1251). */
  readonly pointTable: GatePointTable;
  evaluate(input: PolicyEvaluationInput): PolicyEvaluation;
  /**
   * Effectful evaluation (#1256): resolves the matched rows' asynchronous
   * consultants (the hook process) IN ROW ORDER — each consultant receives
   * the fold's value as of its position (r5 H-1) — then runs the synchronous
   * fold with every settled result prepared. The sync `evaluate` on a consult
   * row has no prepared result and folds `handler_unavailable` -> deny
   * fail-closed.
   */
  evaluateEffect?(input: PolicyEvaluationInput): Effect.Effect<PolicyEvaluation>;
}

function innerOperation(value: PlainValue): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const operation = value.operation;
  if (operation === null || typeof operation !== "object" || Array.isArray(operation))
    return undefined;
  return typeof operation.op === "string" ? operation.op : undefined;
}

const VERDICT_PRECEDENCE: Record<"deny" | "require_approval" | "allow", readonly RowVerdict["type"][]> = {
  deny: ["deny"],
  require_approval: ["require_approval"],
  allow: ["allow"],
};

/** The projected gate's `when` record for one legacy evaluation input. */
function projectedWhenOf(input: PolicyEvaluationInput): Record<string, PlainValue> {
  const when: Record<string, PlainValue> = {};
  if (input.op !== undefined) when.op = input.op;
  const operation = innerOperation(input.value);
  if (operation !== undefined) when.operation = operation;
  if (input.role !== undefined) when.role = input.role;
  if (input.sessionId !== undefined) when.sessionId = input.sessionId;
  return when;
}

/**
 * The next async consultation a fresh decision for this input would make
 * (#1256 r5 H-1): the ordered fold runs — sync rows included — up to the
 * first matched consult row whose async ref has no `prepared` result yet, and
 * that row surfaces here CARRYING THE FOLD'S VALUE AT ITS POSITION. Undefined
 * when the input refuses before the gate, the recorded decision would replay,
 * or every async row is prepared. `evaluateEffect` resolves consultations one
 * at a time through this probe so a later guard judges the value an earlier
 * rewrite actually sends to the executor.
 */
export interface PlannedConsult extends PendingConsult {
  /** The projected gate point the consultation addresses. */
  readonly point: string;
}

export function nextProjectedConsult(
  projected: ProjectedGeneration,
  handlers: ReadonlyMap<string, GateHandler>,
  table: GatePointTable,
  input: PolicyEvaluationInput,
  asyncRefs: ReadonlySet<string>,
  prepared: PreparedResults,
): PlannedConsult | undefined {
  const point = legacyPointOf(input.kind, input.phase);
  if (point === undefined || !table.has(point)) return undefined;
  if (input.kind === "message" && input.op === "send_message" && input.message === undefined)
    return undefined;
  const outcome = projected.gate.decide(
    point,
    { when: projectedWhenOf(input), value: clonePlain(input.value), context: input.message },
    {
      handlers: (ref) => handlers.get(ref),
      ...(input.recorded === undefined ? {} : { recorded: input.recorded }),
      prepared,
      pendingAsync: asyncRefs,
    },
  );
  return outcome.pending === undefined ? undefined : { ...outcome.pending, point };
}

export function evaluateProjected(
  projected: ProjectedGeneration,
  handlers: ReadonlyMap<string, GateHandler>,
  generation: number,
  contentHash: string,
  table: GatePointTable,
  input: PolicyEvaluationInput,
  prepared?: PreparedResults,
): PolicyEvaluation {
  // The recorded decision is replay input, never part of the input identity.
  const { recorded, ...identity } = input;
  const inputHash = canonicalDigest(identity);
  const refused = (reason: string): PolicyEvaluation =>
    Object.freeze({
      generation,
      snapshotHash: contentHash,
      inputHash,
      matchedRuleIds: Object.freeze([]),
      transforms: Object.freeze([]),
      verdict: "deny" as const,
      reason,
      value: clonePlain(input.value),
      effects: Object.freeze([]),
      obligations: Object.freeze([]),
    });
  const point = legacyPointOf(input.kind, input.phase);
  if (point === undefined || !table.has(point)) return refused("unknown_point");
  if (input.kind === "message" && input.op === "send_message" && input.message === undefined)
    return refused("message_context_missing");

  const when = projectedWhenOf(input);

  const outcome = projected.gate.decide(
    point,
    { when, value: clonePlain(input.value), context: input.message },
    {
      handlers: (ref) => handlers.get(ref),
      ...(recorded === undefined ? {} : { recorded }),
      ...(prepared === undefined ? {} : { prepared }),
    },
  );
  const matched = outcome.decision.rowIds.flatMap((id) => {
    const row = projected.rowById.get(id);
    return row === undefined ? [] : [row];
  });
  const transforms = matched.flatMap((row) =>
    row.verdict.type === "transform" ? [Object.freeze({ ruleId: row.name, ref: row.verdict.ref })] : [],
  );
  const obligations = matched.flatMap((row) =>
    row.verdict.type === "obligation"
      ? [{ ref: row.verdict.ref, metric: row.verdict.metric, limit: row.verdict.limit }]
      : [],
  );
  const effects = matched.flatMap((row) =>
    row.verdict.type === "allow" ? (row.verdict.effects ?? []) : [],
  );
  const verdict: EffectiveRowVerdict =
    outcome.decision.verdict !== "allow"
      ? outcome.decision.verdict
      : transforms.length > 0
        ? "transform"
        : obligations.length > 0
          ? "obligation"
          : "allow";
  const reason =
    projectedReason(outcome.decision.verdict, matched) ??
    consultedReason(outcome.decision);

  return Object.freeze({
    generation,
    snapshotHash: contentHash,
    inputHash,
    matchedRuleIds: Object.freeze(matched.map((row) => row.name)),
    transforms: Object.freeze(transforms),
    ...(transforms.length === 1 ? { ref: transforms[0]?.ref } : {}),
    verdict,
    ...(reason === undefined ? {} : { reason }),
    value: outcome.value,
    effects: Object.freeze(effects),
    obligations: Object.freeze(obligations),
    gate: outcome.decision,
    replayed: outcome.replayed,
  });
}

/** The highest-precedence matched row's reason: deny defaults to `denied`. */
function projectedReason(
  verdict: "deny" | "require_approval" | "allow",
  matched: readonly CompiledRow[],
): string | undefined {
  const types = VERDICT_PRECEDENCE[verdict];
  for (const row of matched) {
    if (!types.includes(row.verdict.type)) continue;
    if (row.verdict.type === "deny") return row.verdict.reason ?? "denied";
    if (row.verdict.type === "require_approval") return row.verdict.reason;
    if (row.verdict.type === "allow") {
      const reason = row.verdict.reason ?? row.verdict.reasonCodes?.[0];
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

/**
 * A consulted guard's reason (#1256): the first consulted payload carrying a
 * string `reason`, else — on a deny — the first recorded fact's code (e.g.
 * `handler_unavailable` on the sync path of an async consultant row).
 */
function consultedReason(decision: GateDecision): string | undefined {
  for (const entry of decision.consulted) {
    const payload = entry.payload;
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const reason = payload.reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  }
  if (decision.verdict === "deny") return decision.facts[0]?.code;
  return undefined;
}

export function failedSnapshot(error: PolicyCompileError, table: GatePointTable): CompiledPolicySnapshot {
  const contentHash = canonicalDigest({ generation: error.generation, error: error.data });
  return Object.freeze({
    generation: error.generation,
    contentHash,
    pointTable: table,
    evaluate(input: PolicyEvaluationInput) {
      const { recorded: _recorded, ...identity } = input;
      return Object.freeze({
        generation: error.generation,
        snapshotHash: contentHash,
        inputHash: canonicalDigest(identity),
        matchedRuleIds: Object.freeze([]),
        transforms: Object.freeze([]),
        verdict: "deny",
        reason: error.data.composeCode ?? error.code,
        value: clonePlain(input.value),
        effects: Object.freeze([]),
        obligations: Object.freeze([]),
        error: Object.freeze(error.data),
      });
    },
  });
}
