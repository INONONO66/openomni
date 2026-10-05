import type { GateRow, PlainValue, PointId } from "@openomni/protocol";
import { matchesMessage, type MessagePolicyContext } from "./match";
import { GateComposeError, type GatePointTable } from "../points";
import { compileGateRows, type CompiledGate } from "./compose";
import { legacyPointOf } from "./migrate";
import type { CompiledRow, Match } from "./legacy-rows";
import type { HandlerTable } from "./registry";

// ─── projection: historical rows onto the fourteen-point gate (#1251) ───

/**
 * The compiled gate plus the row identities behind each projected gate row;
 * the gate is the single production evaluator and this metadata only formats
 * its decision back into the legacy `PolicyEvaluation` shape.
 */
export interface ProjectedGeneration {
  readonly gate: CompiledGate<MessagePolicyContext>;
  readonly rowById: ReadonlyMap<string, CompiledRow>;
}

/** The legacy row's condition fields, carried verbatim in the gate row's `when`. */
function projectedWhen(match: Match): Record<string, PlainValue> {
  const when: Record<string, PlainValue> = {};
  if (match.op !== undefined) when.op = match.op;
  if (match.operation !== undefined) when.operation = match.operation;
  if (match.role !== undefined) when.role = match.role;
  if (match.sessionId !== undefined) when.sessionId = match.sessionId;
  return when;
}

/** A rewrite row's real fields: the first path segments its transform touches. */
function transformFields(config: PlainValue | undefined): string[] {
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config === undefined
  )
    return [];
  const declared = Array.isArray(config.fields) ? config.fields : undefined;
  const paths = Array.isArray(config.paths) ? config.paths : undefined;
  const segments = (declared ?? paths ?? []).flatMap((entry) =>
    typeof entry === "string"
      ? [declared === undefined ? (entry.split(".")[0] ?? entry) : entry]
      : [],
  );
  return [...new Set(segments)];
}

function projectedDoHow(row: CompiledRow): Pick<GateRow, "do" | "how"> {
  switch (row.verdict.type) {
    case "transform":
      return {
        do: "rewrite",
        how: {
          ref: row.verdict.ref,
          fields: transformFields(row.verdict.config),
          ...(row.verdict.config === undefined ? {} : { params: row.verdict.config }),
        },
      };
    case "obligation":
      return {
        do: "gate",
        how: {
          verdict: "allow",
          ref: row.verdict.ref,
          metric: row.verdict.metric,
          limit: row.verdict.limit,
        },
      };
    case "consult":
      // A consulted guard: the named service decides, never a constant
      // verdict; `observe: true` projects the audit-only row (#1256 — a
      // PostToolUse hook annotates, it cannot retroactively block).
      return {
        do: row.verdict.observe === true ? "observe" : "gate",
        how: {
          ref: row.verdict.ref,
          ...(row.verdict.config === undefined ? {} : { params: row.verdict.config }),
        },
      };
    default:
      return { do: "gate", how: { verdict: row.verdict.type } };
  }
}

/**
 * Every point one historical row governs. The retired v3 point mapping routed
 * compaction operations through `turn/post`, so a wildcard `turn/post` row is
 * projected onto the compaction point too; op-specific compaction rows were
 * already converted onto `compaction/pre` before parsing.
 */
function projectedPoints(row: CompiledRow, table: GatePointTable): PointId[] {
  const point = legacyPointOf(row.kind, row.phase);
  if (point === undefined || !table.has(point))
    throw new GateComposeError({ code: "unknown_point", point: `${row.kind}.${row.phase}` });
  if (point === "turn.post" && row.match.op === undefined && table.has("compaction.pre"))
    return [point, "compaction.pre"];
  return [point];
}

/**
 * Compiles the generation's rows through the gate-row compiler — the single
 * production evaluator (#1251). Rows are ordered by legacy precedence
 * (priority descending, name ascending); conditions the exact-equality `when`
 * cannot express (message rule tables) compile to per-row matchers.
 */
export function projectGeneration(
  parsed: readonly CompiledRow[],
  generation: number,
  table: GatePointTable,
  registry: HandlerTable,
): ProjectedGeneration {
  const ordered = [...parsed].sort(
    (left, right) => right.priority - left.priority || left.name.localeCompare(right.name),
  );
  const gateRows: GateRow[] = [];
  const rowById = new Map<string, CompiledRow>();
  const matchers = new Map<string, (context: MessagePolicyContext | undefined) => boolean>();
  ordered.forEach((row, index) => {
    for (const point of projectedPoints(row, table)) {
      const id = `legacy/${point}#${index}`;
      gateRows.push({
        id,
        on: point,
        when: projectedWhen(row.match),
        ...projectedDoHow(row),
        order: index,
        generation,
      });
      rowById.set(id, row);
      const rule = row.match.message;
      if (rule !== undefined) matchers.set(id, (context) => matchesMessage(rule, context));
    }
  });
  const gate = compileGateRows<MessagePolicyContext>({
    table,
    rows: gateRows,
    handlers: [
      ...registry.transformers,
      ...registry.obligations,
      ...(registry.consultants ?? []),
    ].map(({ name }) => name),
    generation,
    matchers,
  });
  return { gate, rowById };
}
