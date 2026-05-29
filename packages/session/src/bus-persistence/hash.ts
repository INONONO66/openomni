import { createHash } from "node:crypto";

/**
 * Fixed seed for the first event in any chain. Chosen to be recognizable
 * in debugging while carrying no semantic meaning.
 */
export const GENESIS_SEED = "openomni:genesis:v1";

/**
 * Deterministic hash of a bus event record. The input fields are joined
 * with a pipe delimiter and fed to SHA-256. The result is a 64-char hex
 * string suitable for storage and comparison.
 *
 * Field order matters — changing it invalidates every existing chain.
 *
 * Threat model: this is a public hash (no secret key / HMAC). Any party
 * with write access to both bus_event and event_chain can recompute a
 * consistent chain from scratch. The chain detects accidental corruption
 * and uncoordinated edits, NOT a determined attacker with full DB access.
 * For stronger guarantees, add external anchoring (e.g. periodic merkle
 * root to an on-chain registry or RFC 3161 timestamping service).
 */
export function computeEventHash(input: {
  readonly prevHash: string;
  readonly eventType: string;
  readonly data: string;
  readonly traceId: string;
  readonly timeCreated: number;
}): string {
  const payload = [
    input.prevHash,
    input.eventType,
    input.data,
    input.traceId,
    String(input.timeCreated),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}
