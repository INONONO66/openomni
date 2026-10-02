import {
  type GateDecision,
  NamedError,
  type EmitKind,
  type GateAnnotation,
  type GateRow,
  type GateVerdict,
  type PlainValue,
  type PointId,
  canonicalDigest,
  emittedRowKey,
} from "@openomni/protocol";
import { z } from "zod";
import { GateComposeError, type GatePointTable } from "../points";
import { admitRow } from "./admit";
import { clonePlain } from "./match";

/**
 * Gate-row compiler and evaluator (#1251): compiles the single row contract
 * against the merged point registration table at startup or generation change
 * (rejecting fail-closed with the compose rejection codes defined in #1255)
 * and folds every matching row into one decision per point: deny beats
 * approval beats allow, every matched row id is recorded.
 */

/** A dynamic service reference outside the row's requires; recorded as a fact at call time. */
const GateRequirementError = NamedError.create(
  "GateRequirementError",
  z.object({ rowId: z.string(), ref: z.string() }).strict(),
);

interface GateHandlerInput {
  readonly value: PlainValue;
  readonly params: PlainValue;
  /** The row's requires collection: only `how.ref` and declared `how.requires` resolve. */
  readonly service: (ref: string) => GateHandler;
}

interface GateHandlerResult {
  readonly verdict?: GateVerdict;
  readonly value?: PlainValue;
  /** Recorded as the consulted payload; an undefined payload is observe-only. */
  readonly payload?: PlainValue;
}

export type GateHandler = (input: GateHandlerInput) => GateHandlerResult;

interface GateEmission {
  readonly key: string;
  readonly kind: EmitKind;
  readonly rowId: string;
  readonly intent: PlainValue;
}

interface GateDecideInput<Context> {
  readonly when: Readonly<Record<string, PlainValue>>;
  readonly value: PlainValue;
  /** Opaque consultation context for compiled per-row matchers (e.g. message rule tables). */
  readonly context?: Context;
}

interface GateDecideOptions {
  readonly handlers?: (ref: string) => GateHandler | undefined;
  /** A persisted decision for this point; same input hash replays it verbatim. */
  readonly recorded?: GateDecision;
}

interface GateOutcome {
  readonly decision: GateDecision;
  readonly value: PlainValue;
  readonly emissions: readonly GateEmission[];
  readonly replayed: boolean;
}

export interface CompiledGate<Context = never> {
  readonly generation: number;
  rowsAt(point: PointId): readonly GateRow[];
  decide(point: PointId, input: GateDecideInput<Context>, options?: GateDecideOptions): GateOutcome;
}

export interface CompileGateRowsOptions<Context = never> {
  readonly table: GatePointTable;
  readonly rows: readonly GateRow[];
  /** Registered service refs (`<bundle>/<service>` or auto-registered wrappers). */
  readonly handlers: readonly string[];
  readonly generation: number;
  /**
   * Row-id-keyed condition predicates evaluated in addition to the row's
   * `when` equality — the compiled form of conditions the exact-equality
   * `when` cannot express (message rule tables).
   */
  readonly matchers?: ReadonlyMap<string, (context: Context | undefined) => boolean>;
}

function foldVerdict(folded: GateVerdict, next: GateVerdict): GateVerdict {
  if (folded === "deny" || next === "deny") return "deny";
  if (folded === "require_approval" || next === "require_approval") return "require_approval";
  return "allow";
}

function plainRecord(value: PlainValue): Readonly<Record<string, PlainValue>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

/**
 * Only the declared rewritable fields flow from the handler's output into the
 * prior value; a declared field absent from the output is removed (redaction).
 */
function applyRewrite(prior: PlainValue, fields: readonly string[], output: PlainValue): PlainValue {
  const base = plainRecord(prior);
  if (base === undefined) return prior;
  const source = plainRecord(output) ?? {};
  const next = { ...base };
  for (const field of fields) {
    const replacement = source[field];
    if (replacement === undefined) delete next[field];
    else next[field] = replacement;
  }
  return next;
}

/** One admitted row with its compile-time narrowed emit kind and condition predicate. */
interface CompiledGateRow<Context> {
  readonly row: GateRow;
  readonly emit: EmitKind | undefined;
  readonly matcher: ((context: Context | undefined) => boolean) | undefined;
}

export function compileGateRows<Context = never>(
  options: CompileGateRowsOptions<Context>,
): CompiledGate<Context> {
  const handlers = new Set(options.handlers);
  const seen = new Set<string>();
  const byPoint = new Map<string, CompiledGateRow<Context>[]>();
  for (const row of options.rows) {
    if (seen.has(row.id)) throw new GateComposeError({ code: "duplicate", rowId: row.id, point: row.on });
    seen.add(row.id);
    const emit = admitRow(row, options.table, handlers);
    const bucket = byPoint.get(row.on) ?? [];
    bucket.push({ row, emit, matcher: options.matchers?.get(row.id) });
    byPoint.set(row.on, bucket);
  }
  for (const bucket of byPoint.values()) {
    bucket.sort(
      (left, right) => left.row.order - right.row.order || left.row.id.localeCompare(right.row.id),
    );
  }

  function matches(entry: CompiledGateRow<Context>, input: GateDecideInput<Context>): boolean {
    const whenMatch = Object.entries(entry.row.when).every(
      ([field, expected]) => canonicalDigest(input.when[field] ?? null) === canonicalDigest(expected),
    );
    return whenMatch && (entry.matcher === undefined || entry.matcher(input.context));
  }

  function decide(
    point: PointId,
    input: GateDecideInput<Context>,
    decideOptions: GateDecideOptions = {},
  ): GateOutcome {
    const inputHash = canonicalDigest({ point, when: { ...input.when }, value: input.value });
    const entries = byPoint.get(point) ?? [];
    const recorded = decideOptions.recorded;
    // Matcher context is a decision input: a recorded decision replays only
    // when every context-dependent row still matches exactly as recorded.
    const matchersUnchanged = (record: GateDecision): boolean =>
      entries.every(
        (entry) =>
          entry.matcher === undefined ||
          matches(entry, input) === record.rowIds.includes(entry.row.id),
      );
    if (
      recorded !== undefined &&
      recorded.point === point &&
      recorded.inputHash === inputHash &&
      matchersUnchanged(recorded)
    ) {
      // Replay restores the recorded rewrite output without invoking handlers.
      return { decision: recorded, value: recorded.output, emissions: [], replayed: true };
    }
    const state = initialFoldState(input.value);
    for (const entry of entries) {
      if (matches(entry, input)) applyRow(entry.row, entry.emit, state, inputHash, decideOptions);
    }
    const decision: GateDecision = {
      point,
      verdict: state.verdict,
      rowIds: state.rowIds,
      obligations: state.obligations,
      consulted: state.consulted,
      annotations: state.annotations,
      facts: state.facts,
      output: state.value,
      inputHash,
      generation: options.generation,
    };
    return { decision, value: state.value, emissions: state.emissions, replayed: false };
  }

  return {
    generation: options.generation,
    rowsAt: (point) => (byPoint.get(point) ?? []).map((entry) => entry.row),
    decide,
  };
}

interface FoldState {
  verdict: GateVerdict;
  readonly rowIds: string[];
  readonly obligations: { metric: string; limit: number }[];
  readonly consulted: { ref: string; digest: string; payload: PlainValue }[];
  readonly annotations: GateAnnotation[];
  readonly facts: { rowId: string; ref: string; code: string }[];
  value: PlainValue;
  readonly emissions: GateEmission[];
}

function initialFoldState(value: PlainValue): FoldState {
  return {
    verdict: "allow",
    rowIds: [],
    obligations: [],
    consulted: [],
    annotations: [],
    facts: [],
    value,
    emissions: [],
  };
}

function applyRow(
  row: GateRow,
  emit: EmitKind | undefined,
  state: FoldState,
  inputHash: string,
  decideOptions: GateDecideOptions,
): void {
  state.rowIds.push(row.id);
  if (row.do === "observe") {
    observeRow(row, state, decideOptions);
    return;
  }
  if (row.how.metric !== undefined && row.how.limit !== undefined)
    state.obligations.push({ metric: row.how.metric, limit: row.how.limit });
  if (emit !== undefined) {
    state.emissions.push({
      key: emittedRowKey(inputHash, row.id, state.emissions.length),
      kind: emit,
      rowId: row.id,
      intent: row.how.intent ?? null,
    });
    return;
  }
  if (row.how.verdict !== undefined) {
    state.verdict = foldVerdict(state.verdict, row.how.verdict);
    return;
  }
  if (row.how.ref !== undefined) consultRow(row, row.how.ref, state, decideOptions);
}

/**
 * Calls the handler under the row's requires collection — only the row's own
 * `how.ref` and its declared `how.requires` resolve; an escape throws — with
 * an isolated copy of the decision value, so in-place mutation by any handler
 * can never reach the decision.
 */
function invokeGuarded(
  row: GateRow,
  handler: GateHandler,
  value: PlainValue,
  decideOptions: GateDecideOptions,
): GateHandlerResult {
  const allowed = new Set([row.how.ref, ...(row.how.requires ?? [])]);
  return handler({
    value: clonePlain(value),
    params: row.how.params ?? null,
    service: (requested) => {
      const resolved = allowed.has(requested) ? decideOptions.handlers?.(requested) : undefined;
      if (resolved === undefined) throw new GateRequirementError({ rowId: row.id, ref: requested });
      return resolved;
    },
  });
}

/**
 * Observe rows run through a constrained audit-only path (#1251): the handler
 * is invoked and its recorded payload becomes an `audit.annotate` annotation,
 * but nothing an observer returns, mutates, or throws can change the verdict
 * or value — a failure is recorded as a fact and the decision stands.
 */
function observeRow(row: GateRow, state: FoldState, decideOptions: GateDecideOptions): void {
  const ref = row.how.ref;
  if (ref === undefined) return;
  const handler = decideOptions.handlers?.(ref);
  if (handler === undefined) {
    state.facts.push({ rowId: row.id, ref, code: "handler_unavailable" });
    return;
  }
  let result: GateHandlerResult;
  try {
    result = invokeGuarded(row, handler, state.value, decideOptions);
  } catch (cause) {
    if (GateRequirementError.isInstance(cause))
      state.facts.push({ rowId: row.id, ref: cause.data.ref, code: "requirement_escape" });
    else state.facts.push({ rowId: row.id, ref, code: "observer_failed" });
    return;
  }
  if (result.payload === undefined) {
    state.facts.push({ rowId: row.id, ref, code: "unrecorded_response" });
    return;
  }
  state.annotations.push({ rowId: row.id, ref, payload: result.payload });
}

/** Calls the row's handler under the requirement guard and folds its recorded response. */
function consultRow(
  row: GateRow,
  ref: string,
  state: FoldState,
  decideOptions: GateDecideOptions,
): void {
  const handler = decideOptions.handlers?.(ref);
  if (handler === undefined) {
    state.facts.push({ rowId: row.id, ref, code: "handler_unavailable" });
    state.verdict = foldVerdict(state.verdict, "deny");
    return;
  }
  let result: GateHandlerResult;
  try {
    result = invokeGuarded(row, handler, state.value, decideOptions);
  } catch (cause) {
    if (!GateRequirementError.isInstance(cause)) throw cause;
    state.facts.push({ rowId: row.id, ref: cause.data.ref, code: "requirement_escape" });
    state.verdict = foldVerdict(state.verdict, "deny");
    return;
  }
  if (result.payload === undefined) {
    // Unrecorded response: observe-only; it cannot change the decision.
    state.facts.push({ rowId: row.id, ref, code: "unrecorded_response" });
    return;
  }
  state.consulted.push({ ref, digest: canonicalDigest(result.payload), payload: result.payload });
  if (row.do === "rewrite") {
    state.value = applyRewrite(state.value, row.how.fields ?? [], result.value ?? null);
    return;
  }
  state.verdict = foldVerdict(state.verdict, result.verdict ?? "allow");
}
