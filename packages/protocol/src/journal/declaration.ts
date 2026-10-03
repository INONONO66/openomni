import { z } from "zod";
import { EncodedPayload } from "../ledger/l0.js";

/**
 * One closed journal kind (#1252): its name, payload version and body schema.
 * The journal row is `{seq, kind, version, body, hash}`; `body` is the
 * `{intent, effect}` pair the kind's single writer appends. `version` carries
 * payload evolution so the kind set itself stays closed.
 */
export interface KindDeclaration<Kind extends string = string> {
  readonly kind: Kind;
  readonly version: 1;
  readonly schema: z.ZodType;
}

/** Every journal row body: the committed intent/effect pair. */
export const RowBody = z
  .object({
    intent: EncodedPayload,
    effect: EncodedPayload,
  })
  .strict();
export type RowBody = z.infer<typeof RowBody>;

/** Loop-consumption width for an input row: interleave now or wait for seal. */
export const Delivery = z.enum(["steer", "followUp"]);
export type Delivery = z.infer<typeof Delivery>;

/** The one default when an input row carries no explicit delivery. */
export const DEFAULT_DELIVERY: Delivery = "followUp";

function objectValue(value: z.infer<typeof EncodedPayload>["value"]): Record<string, z.infer<typeof EncodedPayload>["value"]> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Fail-closed field check: a named field, when present, must satisfy `field`. */
export function refineField(
  side: "intent" | "effect",
  name: string,
  field: z.ZodType,
): (body: RowBody, context: z.core.$RefinementCtx<RowBody>) => void {
  return (body, context) => {
    const holder = objectValue(body[side].value);
    const value = holder?.[name];
    if (value === undefined) return;
    const parsed = field.safeParse(value);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        path: [side, "value", name],
        message: `invalid ${name}`,
      });
    }
  };
}

export function declare<Kind extends string>(
  kind: Kind,
  schema: z.ZodType,
): KindDeclaration<Kind> {
  return { kind, version: 1, schema };
}
