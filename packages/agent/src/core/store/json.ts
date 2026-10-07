import { PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";

export function parseStoredJson(text: string) {
  return PlainValueSchema.parse(JSON.parse(text));
}

export const SqliteCount = z
  .union([z.number().int(), z.bigint()])
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

// Wall-clock instants mirror protocol EpochMs: finite, non-negative, fractional allowed.
export const SqliteEpochMs = z
  .union([z.number(), z.bigint()])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
