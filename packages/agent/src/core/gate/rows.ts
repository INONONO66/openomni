import type { PointId } from "@openomni/protocol";

/**
 * Versioned gate-row identity writer (#1319): the one module that mints the
 * row ids a compiled generation carries. Generations materialized from now on
 * record this version in their snapshot (`rowsVersion`); decision facts
 * recorded under earlier identities keep their bytes.
 */
export const GATE_ROW_WRITER_VERSION = 1 as const;

/**
 * The minted name segment must satisfy the protocol `GateRowId` grammar
 * (`[a-z][a-z0-9-]*`) for EVERY production row name — bundle-seeded names
 * already carry `/` and `#` (`hooks-json/tool.pre#3`) and message rows carry
 * dots (`message.external.contact`). Each run of characters outside
 * `[a-z0-9]` collapses to one `-`; a token that would not start with a
 * letter gains the `row-` prefix. The mapping is deterministic, so the same
 * rows always mint the same ids; the ordinal keeps colliding tokens unique.
 */
function rowNameToken(name: string): string {
  const token = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (token === "") return "row";
  return /^[a-z]/.test(token) ? token : `row-${token}`;
}

/**
 * The current gate-row identity `<name token>/<point>#<ordinal>` — the
 * `GateRowId`-valid projection of the row's free-form name onto the shape
 * the product bundles already use (for example `hooks-json/tool.pre#3`).
 * `ordinal` is the row's index in the priority-sorted projection order, so
 * two rows sharing a name on the same point still get distinct ids.
 */
export function gateRowId(
  row: { readonly name: string },
  point: PointId,
  ordinal: number,
): string {
  return `${rowNameToken(row.name)}/${point}#${ordinal}`;
}
