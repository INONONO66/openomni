import { createHash } from "node:crypto";

const HEX_32 = /^[0-9a-f]{32}$/;
const NIL = "0".repeat(32);

/**
 * Deterministic W3C trace id for one delegation.
 *
 * Production delegation ids are UUIDs, whose hex digits are exactly a
 * 32-char lowercase trace id once the hyphens go — so the trace id stays
 * greppable 1:1 against the delegation id. Any other id (test doubles) and
 * the nil UUID — the all-zero trace id is invalid per W3C — derive
 * deterministically from a digest instead, so every consumer of the same
 * delegation still lands on the same trace.
 */
export function delegationTraceId(delegationId: string): string {
  const canonical = delegationId.split("-").join("").toLowerCase();
  if (HEX_32.test(canonical) && canonical !== NIL) return canonical;
  return createHash("sha256").update(delegationId).digest("hex").slice(0, 32);
}
