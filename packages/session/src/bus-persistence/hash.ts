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
