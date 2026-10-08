/**
 * `prompt` — a turn input of human/contact/alarm/nudge origin.
 * Single writer: the entity deliver path (`packages/agent/src/core/commit.ts`);
 * capability handlers reach it only through that constructor.
 * `delivery: steer|followUp` (default `followUp`) picks consumption width.
 * Version 2 (#1315): payloads name the delivered input `deliveryId`/
 * `deliveryKind`; `foldDeliveryPayload` below is the version-1 reader.
 */
import type { PlainValue } from "../../json.js";
import { Delivery, RowBody, declare, refineField } from "../declaration.js";

export const prompt = declare(
  "prompt",
  RowBody.superRefine(refineField("intent", "delivery", Delivery)),
  2,
);

/**
 * The version-1 payload field names (#1315): rows written before the
 * `prompt`/`signal`/`turn` version-2 bump persist the delivered input under
 * the retired queue vocabulary. This object and `foldDeliveryPayload`
 * are THE one place the previous names survive; every reader folds through
 * here and no alias is exported.
 */
export const V1_DELIVERY_FIELDS = {
  id: "inboxId",
  ids: "inboxIds",
  kind: "inboxKind",
} as const;

const V2_BY_V1: ReadonlyMap<string, string> = new Map([
  [V1_DELIVERY_FIELDS.id, "deliveryId"],
  [V1_DELIVERY_FIELDS.ids, "deliveryIds"],
  [V1_DELIVERY_FIELDS.kind, "deliveryKind"],
]);

/**
 * Versioned read (#1315): folds a version-1 payload's retired field names to
 * the version-2 names. Stored bytes and the chain hash never change — the
 * fold runs strictly after hash verification, on the decoded value. A
 * payload already carrying the version-2 name keeps it.
 */
export function foldDeliveryPayload(value: PlainValue): PlainValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  let next: Record<string, PlainValue> | undefined;
  for (const [v1, v2] of V2_BY_V1) {
    if (!(v1 in value) || v2 in value) continue;
    next ??= { ...value };
    next[v2] = next[v1] as PlainValue;
    delete next[v1];
  }
  return next ?? value;
}
