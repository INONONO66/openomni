import { z } from "zod";
import { canonicalDigest, PlainValueSchema } from "../json.js";
import { PointDo, PointId } from "./point.js";

/** Row identity `<bundle>/<point>#<n>`, traceable to bundle and generation. */
export const GateRowId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)?#(?:0|[1-9][0-9]*)$/);

/**
 * `how.ref` names a registered bundle service (`<bundle>/<service>`) or an
 * auto-registered top-level function wrapper (`<bundle>/<point>#<n>`).
 */
export const GateHandlerRef = z
  .string()
  .regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9.-]*(?:#(?:0|[1-9][0-9]*))?$/);

export const GateVerdict = z.enum(["allow", "deny", "require_approval"]);
export type GateVerdict = z.infer<typeof GateVerdict>;

/**
 * Row execution parameters. A constant verdict row carries `verdict` and no
 * `ref`; a consulted row names its handler in `ref`. `emit` rows journal an
 * `emit` intent kind (validated against the allowed emit set at compose);
 * obligation rows fold `metric`/`limit` into `turn.post`.
 */
export const GateHow = z
  .object({
    ref: GateHandlerRef.optional(),
    /** Declared dependency collection: extra service refs the handler may resolve. */
    requires: z.array(GateHandlerRef).optional(),
    verdict: GateVerdict.optional(),
    emit: z.string().min(1).optional(),
    intent: PlainValueSchema.optional(),
    fields: z.array(z.string().min(1)).optional(),
    metric: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
    params: PlainValueSchema.optional(),
  })
  .strict();
export type GateHow = z.infer<typeof GateHow>;

/** The single policy row contract (#1251): point/condition/action. */
export const GateRow = z
  .object({
    id: GateRowId,
    on: PointId,
    when: z.record(z.string(), PlainValueSchema),
    do: PointDo,
    how: GateHow,
    order: z.number().int(),
    generation: z.number().int().positive(),
  })
  .strict();
export type GateRow = z.infer<typeof GateRow>;

/** One consulted handler response, recorded with the decision for replay. */
export const GateConsulted = z
  .object({
    ref: GateHandlerRef,
    digest: z.string().min(1),
    payload: PlainValueSchema,
  })
  .strict();
export type GateConsulted = z.infer<typeof GateConsulted>;

/** One observe-row audit annotation; recorded with the decision, never part of it. */
export const GateAnnotation = z
  .object({
    rowId: GateRowId,
    ref: GateHandlerRef,
    payload: PlainValueSchema,
  })
  .strict();
export type GateAnnotation = z.infer<typeof GateAnnotation>;

/** A recorded call-time rejection (e.g. a dynamic service reference escaping the row's requires). */
export const GateFact = z
  .object({
    rowId: GateRowId,
    ref: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();
export type GateFact = z.infer<typeof GateFact>;

/**
 * The folded decision at one point: deny beats approval beats allow, every
 * matched row id is recorded, gate/rewrite responses carry their `consulted`
 * payloads, and `output` carries the final rewritten value, so an identical
 * input replays the identical decision and value without invoking handlers.
 */
export const GateDecision = z
  .object({
    point: PointId,
    verdict: GateVerdict,
    rowIds: z.array(GateRowId),
    obligations: z.array(z.object({ metric: z.string().min(1), limit: z.number().int().positive() }).strict()),
    consulted: z.array(GateConsulted),
    /** Observe-row audit annotations (`audit.annotate`); isolated from the decision. */
    annotations: z.array(GateAnnotation),
    facts: z.array(GateFact),
    /** The value after every rewrite row, replayed verbatim with the decision. */
    output: PlainValueSchema,
    inputHash: z.string().min(1),
    generation: z.number().int().positive(),
  })
  .strict();
export type GateDecision = z.infer<typeof GateDecision>;

/** Emitted-row idempotency key: replay never duplicates an emission. */
export function emittedRowKey(inputHash: string, rowId: string, index: number): string {
  return canonicalDigest([inputHash, rowId, index]);
}

/**
 * Compose rejection codes (#1255 owns the code set; #1251 consumes it):
 * `unknown_point` — row targets a point missing from the merged registration
 * table, including an off or absent capability's point and an unmappable
 * historical row; `unknown_handler` — unregistered `how.ref`; `duplicate` —
 * duplicate point registration or row id; `bad_action`/`bad_field` — a `do`
 * or field outside the point record; `post_end_emit` — emit at or after turn
 * end; `builtin_removed` — a sealed core point is missing.
 */
export const ComposeRejectionCode = z.enum([
  "unknown_point",
  "unknown_handler",
  "duplicate",
  "bad_action",
  "bad_field",
  "post_end_emit",
  "builtin_removed",
]);
export type ComposeRejectionCode = z.infer<typeof ComposeRejectionCode>;
