import type { PointId } from "@openomni/protocol";

/**
 * Versioned gate-row identity writer (#1319): the one module that mints the
 * row ids a compiled generation carries. Generations materialized from now on
 * record this version in their snapshot (`rowsVersion`); decision facts
 * recorded under earlier identities keep their bytes.
 */
export const GATE_ROW_WRITER_VERSION = 1 as const;

/**
 * The current gate-row identity `<row name>/<point>#<ordinal>` — the shape
 * the product bundles already use (for example `hooks-json/tool.pre#3`).
 * `ordinal` is the row's index in the priority-sorted projection order, so
 * two rows sharing a name on the same point still get distinct ids.
 */
export function gateRowId(
  row: { readonly name: string },
  point: PointId,
  ordinal: number,
): string {
  return `${row.name}/${point}#${ordinal}`;
}
