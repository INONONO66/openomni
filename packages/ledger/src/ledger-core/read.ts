import type { Database } from "bun:sqlite";
import { Ledger as LedgerTypes, PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";
import { parseStoredJson } from "../storage/sqlite-json-data";

const StoredFact = LedgerTypes.RecordedFact.extend({
  data: z.record(z.string(), PlainValueSchema),
});

const FactRow = z
  .object({
    stream_id: z.string(),
    seq: z.number().int().nonnegative(),
    type: z.string(),
    data: z.string(),
    time_created: z.number(),
  })
  .transform((row) =>
    StoredFact.parse({
      streamId: row.stream_id,
      seq: row.seq,
      type: row.type,
      data: parseStoredJson(row.data),
      timeCreated: row.time_created,
    }),
  );

/** Newest fact of one stream; persisted data is validated JSON, not a domain verdict. */
export function headFact(db: Database, streamId: string) {
  const fact = FactRow.nullable().parse(
    db
      .query(
        "SELECT stream_id, seq, type, data, time_created FROM ledger_event WHERE stream_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(streamId),
  );
  return fact ?? undefined;
}

/** Facts of one type across streams, ordered by stream identity and sequence. */
export function factsByType(db: Database, type: string) {
  return FactRow.array().parse(
    db
      .query(
        "SELECT stream_id, seq, type, data, time_created FROM ledger_event WHERE type = ? ORDER BY stream_id ASC, seq ASC",
      )
      .all(type),
  );
}
