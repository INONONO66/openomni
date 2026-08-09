import { createHash } from "node:crypto";

/**
 * Ledger event hash for the #510 clean baseline chain.
 *
 * Same conventions as the legacy bus_event chain (sha256 hex, shared
 * GENESIS_SEED from bus-persistence/hash.ts — that file stays the owner of
 * the genesis constant and of the legacy field set we must remain able to
 * read). Two deliberate differences for the new chain:
 *   - the payload is a JSON-array framing instead of pipe-joins, so a `|`
 *     inside `data` can never alias another field boundary;
 *   - streamId and seq are hashed in, binding each event to its stream
 *     position (a row moved or renumbered breaks the chain).
 */
export function computeLedgerEventHash(input: {
  readonly prevHash: string;
  readonly streamId: string;
  readonly seq: number;
  readonly type: string;
  readonly data: string;
  readonly timeCreated: number;
}): string {
  const payload = JSON.stringify([
    input.prevHash,
    input.streamId,
    input.seq,
    input.type,
    input.data,
    input.timeCreated,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}
