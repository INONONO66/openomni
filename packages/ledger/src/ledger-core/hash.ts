import { createHash } from "node:crypto";

export const GENESIS_SEED = "openomni:genesis:v1";

/**
 * Ledger event hash for the #510 clean baseline chain.
 *
 * Same conventions as the historical bus_event chain (sha256 hex and the
 * preserved genesis seed). Two deliberate differences for the new chain:
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
