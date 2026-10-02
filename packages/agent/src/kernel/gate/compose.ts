import {
  EMIT_KINDS,
  type GateDecision,
  NamedError,
  RowVerdictRead,
  type EmitKind,
  type GateAnnotation,
  type GateRow,
  type GateVerdict,
  type PlainValue,
  type PointId,
  type PointRecord,
  type PolicyRow,
  canonicalDigest,
  emittedRowKey,
} from "@openomni/protocol";
import { z } from "zod";
import { GateComposeError, type GatePointTable } from "../points";

/**
 * Gate-row compiler (#1251): compiles the single row contract against the
 * merged point registration table at startup or generation change and rejects
 * fail-closed with the compose rejection codes defined in #1255.
 */

/** A dynamic service reference outside the row's requires; recorded as a fact at call time. */
const GateRequirementError = NamedError.create(
  "GateRequirementError",
  z.object({ rowId: z.string(), ref: z.string() }).strict(),
);

interface GateHandlerInput {
  readonly value: PlainValue;
  readonly params: PlainValue;
  /** The row's requires collection: only the row's own `how.ref` resolves. */
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

interface GateDecideInput {
  readonly when: Readonly<Record<string, PlainValue>>;
  readonly value: PlainValue;
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

export interface CompiledGate {
  readonly generation: number;
  rowsAt(point: PointId): readonly GateRow[];
  decide(point: PointId, input: GateDecideInput, options?: GateDecideOptions): GateOutcome;
}

export interface CompileGateRowsOptions {
  readonly table: GatePointTable;
  readonly rows: readonly GateRow[];
  /** Registered service refs (`<bundle>/<service>` or auto-registered wrappers). */
  readonly handlers: readonly string[];
  readonly generation: number;
}

function reject(code: GateComposeError["data"]["code"], row: GateRow, detail?: string): never {
  throw new GateComposeError({
    code,
    rowId: row.id,
    point: row.on,
    ...(detail === undefined ? {} : { ref: detail }),
  });
}

function validateAction(row: GateRow, record: PointRecord): void {
  if (record.allowedDo.includes(row.do)) return;
  if (row.do === "emit" && record.end === true) reject("post_end_emit", row);
  reject("bad_action", row, row.do);
}

function validateFields(row: GateRow, record: PointRecord): void {
  for (const field of Object.keys(row.when)) {
    if (!record.whenFields.includes(field)) reject("bad_field", row, field);
  }
  if (row.do !== "rewrite") return;
  const fields = row.how.fields ?? [];
  if (fields.length === 0) reject("bad_field", row, "fields");
  for (const field of fields) {
    if (!record.rewritableFields.includes(field)) reject("bad_field", row, field);
  }
}

/** Narrows the row's emitted kind at compile; a non-emit row carries none. */
function validateEmit(row: GateRow, record: PointRecord): EmitKind | undefined {
  if (row.do !== "emit") return undefined;
  if (record.end === true) reject("post_end_emit", row);
  const kind = EMIT_KINDS.find((candidate) => candidate === row.how.emit);
  if (kind === undefined) reject("bad_action", row, row.how.emit ?? "emit");
  return kind;
}

function validateHow(row: GateRow, handlers: ReadonlySet<string>): void {
  const constant = row.how.verdict !== undefined || row.how.metric !== undefined;
  if (row.do === "gate" && !constant && row.how.ref === undefined) reject("bad_action", row, "how");
  if ((row.do === "rewrite" || row.do === "observe") && row.how.ref === undefined)
    reject("bad_action", row, "how");
  if ((row.how.metric === undefined) !== (row.how.limit === undefined))
    reject("bad_field", row, "limit");
  if (row.how.ref !== undefined && !handlers.has(row.how.ref))
    reject("unknown_handler", row, row.how.ref);
}

function matches(row: GateRow, when: Readonly<Record<string, PlainValue>>): boolean {
  return Object.entries(row.when).every(
    ([field, expected]) => canonicalDigest(when[field] ?? null) === canonicalDigest(expected),
  );
}

function foldVerdict(folded: GateVerdict, next: GateVerdict): GateVerdict {
  if (folded === "deny" || next === "deny") return "deny";
  if (folded === "require_approval" || next === "require_approval") return "require_approval";
  return "allow";
}

function plainField(value: PlainValue, field: string): PlainValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return field in value ? value[field] : undefined;
}

/** Only the declared rewritable fields flow from the handler's output into the prior value. */
function applyRewrite(prior: PlainValue, fields: readonly string[], output: PlainValue): PlainValue {
  if (prior === null || typeof prior !== "object" || Array.isArray(prior)) return prior;
  const next = { ...prior };
  for (const field of fields) {
    const replacement = plainField(output, field);
    if (replacement !== undefined) next[field] = replacement;
  }
  return next;
}

/** One admitted row with its compile-time narrowed emit kind. */
interface CompiledGateRow {
  readonly row: GateRow;
  readonly emit: EmitKind | undefined;
}

export function compileGateRows(options: CompileGateRowsOptions): CompiledGate {
  const handlers = new Set(options.handlers);
  const seen = new Set<string>();
  const byPoint = new Map<string, CompiledGateRow[]>();
  for (const row of options.rows) {
    if (seen.has(row.id)) reject("duplicate", row);
    seen.add(row.id);
    const record = options.table.get(row.on);
    if (record === undefined) reject("unknown_point", row);
    validateAction(row, record);
    validateFields(row, record);
    const emit = validateEmit(row, record);
    validateHow(row, handlers);
    const bucket = byPoint.get(row.on) ?? [];
    bucket.push({ row, emit });
    byPoint.set(row.on, bucket);
  }
  for (const bucket of byPoint.values()) {
    bucket.sort(
      (left, right) => left.row.order - right.row.order || left.row.id.localeCompare(right.row.id),
    );
  }

  function rowsAt(point: PointId): readonly GateRow[] {
    return (byPoint.get(point) ?? []).map((entry) => entry.row);
  }

  function decide(
    point: PointId,
    input: GateDecideInput,
    decideOptions: GateDecideOptions = {},
  ): GateOutcome {
    const inputHash = canonicalDigest({ point, when: { ...input.when }, value: input.value });
    const recorded = decideOptions.recorded;
    if (recorded !== undefined && recorded.point === point && recorded.inputHash === inputHash) {
      // Replay restores the recorded rewrite output without invoking handlers.
      return { decision: recorded, value: recorded.output, emissions: [], replayed: true };
    }
    const state = initialFoldState(input.value);
    for (const entry of byPoint.get(point) ?? []) {
      if (matches(entry.row, input.when)) applyRow(entry, state, inputHash, decideOptions);
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

  return { generation: options.generation, rowsAt, decide };
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
  entry: CompiledGateRow,
  state: FoldState,
  inputHash: string,
  decideOptions: GateDecideOptions,
): void {
  const row = entry.row;
  state.rowIds.push(row.id);
  if (row.how.metric !== undefined && row.how.limit !== undefined)
    state.obligations.push({ metric: row.how.metric, limit: row.how.limit });
  if (row.do === "observe") {
    observeRow(row, state, decideOptions);
    return;
  }
  if (entry.emit !== undefined) {
    state.emissions.push({
      key: emittedRowKey(inputHash, row.id, state.emissions.length),
      kind: entry.emit,
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

/** Calls the handler under the row's requires collection; an escape throws. */
function invokeGuarded(
  row: GateRow,
  ref: string,
  handler: GateHandler,
  value: PlainValue,
  decideOptions: GateDecideOptions,
): GateHandlerResult {
  return handler({
    value,
    params: row.how.params ?? null,
    service: (requested) => {
      const resolved = requested === ref ? decideOptions.handlers?.(requested) : undefined;
      if (resolved === undefined) throw new GateRequirementError({ rowId: row.id, ref: requested });
      return resolved;
    },
  });
}

/**
 * Observe rows run through a constrained audit-only path (#1251): the handler
 * is invoked and its recorded payload becomes an `audit.annotate` annotation,
 * but nothing an observer returns or throws can change the verdict or value.
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
    result = invokeGuarded(row, ref, handler, state.value, decideOptions);
  } catch (cause) {
    if (!GateRequirementError.isInstance(cause)) throw cause;
    state.facts.push({ rowId: row.id, ref: cause.data.ref, code: "requirement_escape" });
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
    result = invokeGuarded(row, ref, handler, state.value, decideOptions);
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

// ─── latest-only catalog migration (#1251) ───

const LEGACY_POINT_BY_KIND_PHASE: ReadonlyMap<string, PointId> = new Map([
  ["inbox.deliver\u0000pre", "ingress.pre"],
  ["prompt\u0000pre", "prompt.pre"],
  ["turn\u0000pre", "turn.pre"],
  ["turn\u0000post", "turn.post"],
  ["llm\u0000pre", "llm.pre"],
  ["llm\u0000post", "llm.post"],
  ["message\u0000pre", "message.pre"],
  // Session configuration gating is consulted by the core's configure
  // authority; its historical rows belong to the session-open point.
  ["session.configure\u0000pre", "session.open"],
  ["tool\u0000pre", "tool.pre"],
  ["tool\u0000post", "tool.post"],
  ["compaction\u0000pre", "compaction.pre"],
  ["compaction\u0000post", "compaction.post"],
  ["alarm.fired\u0000post", "alarm.fired"],
]);

/** The historical row's registered point, or undefined when it cannot map. */
export function legacyPointOf(kind: string, phase: PolicyRow.Phase): PointId | undefined {
  return LEGACY_POINT_BY_KIND_PHASE.get(`${kind}\u0000${phase}`);
}

type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;

function matchValue(row: PolicyRowDraft): Readonly<Record<string, PlainValue>> {
  const value = row.match.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

/**
 * Converts one historical row's semantics onto the fourteen-point contract
 * (#1251). Compaction moved off the turn envelope: a `turn/post` row matching
 * the historical `op: "compaction"` governs the compaction point itself, so it
 * becomes a `compaction/pre` row matching every compaction operation —
 * a base-era compaction deny keeps refusing summarization after conversion.
 */
export function translateLegacyPolicyRow<Row extends PolicyRowDraft>(row: Row): Row {
  const match = matchValue(row);
  if (row.kind !== "turn" || row.phase !== "post" || match.op !== "compaction") return row;
  const { op: _op, ...rest } = match;
  return {
    ...row,
    kind: "compaction",
    phase: "pre",
    match: { encodingVersion: 1 as const, value: rest },
  };
}

function legacyDoHow(row: PolicyRowDraft, record: PointRecord | undefined): Pick<GateRow, "do" | "how"> {
  const verdict = RowVerdictRead.safeParse(row.verdict.value);
  if (!verdict.success) return { do: "gate", how: {} };
  switch (verdict.data.type) {
    case "transform":
      return {
        do: "rewrite",
        how: { ref: verdict.data.ref, fields: [...(record?.rewritableFields ?? [])] },
      };
    case "obligation":
      return {
        do: "gate",
        how: { verdict: "allow", metric: verdict.data.metric, limit: verdict.data.limit },
      };
    default:
      return { do: "gate", how: { verdict: verdict.data.type } };
  }
}

/**
 * Projects one translated historical row into the gate-row contract so the
 * gate compiler admits every production generation. The legacy match keeps
 * evaluating through the compiled snapshot; admission enforces the point
 * registration, allowed actions, handler registration, and emit rules.
 */
export function legacyGateRow(
  row: PolicyRowDraft,
  index: number,
  generation: number,
  table: GatePointTable,
): GateRow {
  const point = legacyPointOf(row.kind, row.phase);
  if (point === undefined)
    throw new GateComposeError({ code: "unknown_point", point: `${row.kind}.${row.phase}` });
  return {
    id: `legacy/${point}#${index}`,
    on: point,
    when: {},
    ...legacyDoHow(row, table.get(point)),
    order: -row.priority,
    generation,
  };
}

/**
 * Marks a generation as validated against the fourteen-point registration
 * table. The marker is inert: it only ever matches the reserved
 * `point-registry` op, which no execution uses.
 */
export const POINT_GENERATION_ROW: PolicyRowDraft = Object.freeze({
  name: "point-registry",
  kind: "turn",
  phase: "pre",
  match: { encodingVersion: 1 as const, value: { op: "point-registry" } },
  verdict: { encodingVersion: 1 as const, value: { type: "allow", reasonCodes: ["point-registry-v1"] } },
  priority: 0,
});

/** Rejects (fail-closed, `unknown_point`) when any row cannot map to a registered point. */
export function assertPointGenerationRows(
  rows: readonly PolicyRowDraft[],
  table: GatePointTable,
): void {
  for (const row of rows) {
    const point = legacyPointOf(row.kind, row.phase);
    if (point === undefined || !table.has(point))
      throw new GateComposeError({ code: "unknown_point", point: `${row.kind}.${row.phase}` });
  }
}
