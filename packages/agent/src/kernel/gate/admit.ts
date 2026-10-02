import {
  EMIT_KINDS,
  type EmitKind,
  type GateRow,
  type PointRecord,
} from "@openomni/protocol";
import { GateComposeError, type GatePointTable } from "../points";

/**
 * Gate-row admission (#1251): one row is validated against its point record
 * and the registered handler set, rejecting fail-closed with the compose
 * rejection codes defined in #1255.
 */

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
  if (record.rewriteOpen === true) return;
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
  // Audit-only: an observe row may name its handler, params, and requires -
  // never a verdict, obligation, rewrite field, or emission.
  if (
    row.do === "observe" &&
    (row.how.ref === undefined ||
      row.how.verdict !== undefined ||
      row.how.metric !== undefined ||
      row.how.limit !== undefined ||
      row.how.fields !== undefined ||
      row.how.emit !== undefined)
  )
    reject("bad_action", row, "how");
  const constant = row.how.verdict !== undefined || row.how.metric !== undefined;
  if (row.do === "gate" && !constant && row.how.ref === undefined) reject("bad_action", row, "how");
  if (row.do === "rewrite" && row.how.ref === undefined) reject("bad_action", row, "how");
  if ((row.how.metric === undefined) !== (row.how.limit === undefined))
    reject("bad_field", row, "limit");
  for (const ref of [row.how.ref, ...(row.how.requires ?? [])]) {
    if (ref !== undefined && !handlers.has(ref)) reject("unknown_handler", row, ref);
  }
}

/** Admits one row against the registration table; returns its narrowed emit kind. */
export function admitRow(
  row: GateRow,
  table: GatePointTable,
  handlers: ReadonlySet<string>,
): EmitKind | undefined {
  const record = table.get(row.on);
  if (record === undefined) reject("unknown_point", row);
  validateAction(row, record);
  validateFields(row, record);
  const emit = validateEmit(row, record);
  validateHow(row, handlers);
  return emit;
}
