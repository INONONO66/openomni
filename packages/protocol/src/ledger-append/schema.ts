import { z } from "zod";

/**
 * Durability class of a ledger write connection (#510). Decision-class
 * appends run on the single production FULL connection; telemetry runs on a
 * NORMAL group-commit connection and can never be presented as a decision or
 * authorization fact. Phase A ships the vocabulary only — the per-connection
 * split is wired at the writer cutover.
 */
export const Durability = z.enum(["full", "normal"]);
export type Durability = z.infer<typeof Durability>;

/**
 * One decision-class fact to append to an owner stream. `data` is the
 * structured payload; the append core owns its serialization (the stored
 * JSON text is exactly the text fed to the hash chain).
 */
export const Input = z
  .object({
    streamId: z.string().min(1),
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
    /** Milliseconds since epoch; the append core defaults it to now. */
    timeCreated: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Input = z.infer<typeof Input>;

/**
 * CAS guard for `Ledger.append(event, expectedHead)`: the caller's view of
 * the stream head (last appended seq; 0 for an empty stream). A stale value
 * yields `cas_conflict` — retrying from the reported head is the CALLER's
 * decision, never the append core's.
 */
export const ExpectedHead = z.number().int().nonnegative();
export type ExpectedHead = z.infer<typeof ExpectedHead>;

/**
 * Typed append outcome. `appended` carries the changes===1 CAS receipt
 * (seq = expectedHead + 1) plus the chained event hash; `cas_conflict`
 * reports the current head and guarantees nothing was written.
 */
export const Outcome = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("appended"),
      seq: z.number().int().positive(),
      eventHash: z.string().length(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cas_conflict"),
      currentHead: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type Outcome = z.infer<typeof Outcome>;

/**
 * One stored fact as the append core's minimal read API returns it (#510
 * C3): the replay path of a single-fact decision stream re-executes from the
 * recorded fact instead of re-deciding. `data` is the parsed JSON object the
 * writer appended; `timeCreated` is the writer-assigned append time.
 */
export const RecordedFact = z
  .object({
    streamId: z.string().min(1),
    seq: z.number().int().positive(),
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
    timeCreated: z.number().int().nonnegative(),
  })
  .strict();
export type RecordedFact = z.infer<typeof RecordedFact>;

export const ChainBreakCode = z.enum([
  /** Recomputed event hash differs from the stored `event_hash`. */
  "hash_mismatch",
  /** `prev_hash` does not equal the previous event's `event_hash` (or the genesis seed at seq 1). */
  "link_mismatch",
  /** `ledger_head.head` disagrees with the newest stored seq. */
  "head_mismatch",
]);
export type ChainBreakCode = z.infer<typeof ChainBreakCode>;

/**
 * Chain-break FACT emitted by boot tail verification (#510): boot records it
 * (plus a Governor incident at the consumer) and continues — it never
 * refuses boot. Full-chain verification is the #226 offline restore drill.
 * `expected` is what the chain implies, `actual` is what is stored.
 */
export const ChainBreak = z
  .object({
    streamId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    code: ChainBreakCode,
    expected: z.string(),
    actual: z.string(),
    detectedAt: z.number(),
  })
  .strict();
export type ChainBreak = z.infer<typeof ChainBreak>;
