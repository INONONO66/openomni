import { PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";

export function parseStoredJson(text: string) {
  return PlainValueSchema.parse(JSON.parse(text));
}

// Validate the SQLite envelope and the domain value at the same read boundary.
export function sqliteJsonData<T>(schema: z.ZodType<T>) {
  return z.object({ data: z.string() }).transform((row) => schema.parse(parseStoredJson(row.data)));
}

export const SqliteCount = z
  .union([z.number().int(), z.bigint()])
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const SqliteCountRow = z.object({ count: SqliteCount });
