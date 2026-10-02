import {
  type GateDecision,
  type EmitKind,
  type GateRow,
  type PlainValue,
  type PointId,
  canonicalDigest,
} from "@openomni/protocol";
import { GateComposeError, type GatePointTable } from "../points";
import { admitRow } from "./admit";
import { applyRow, initialFoldState, type GateEmission, type GateHandler } from "./fold";

export type { GateHandler } from "./fold";

/**
 * Gate-row compiler and evaluator (#1251): compiles the single row contract
 * against the merged point registration table at startup or generation change
 * (rejecting fail-closed with the compose rejection codes defined in #1255)
 * and folds every matching row into one decision per point: deny beats
 * approval beats allow, every matched row id is recorded.
 */

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
      if (matches(entry, input)) applyRow(entry.row, entry.emit, state, inputHash, decideOptions.handlers);
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

