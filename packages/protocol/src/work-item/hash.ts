import { createHash } from "node:crypto";

export function criterionId(workItemId: string, index: number, statement: string): string {
  return `criterion:${workItemId}:${index}:${stableToken(statement)}`;
}

export function sha256JsonRef(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function stableToken(input: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function generateHash(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  // constrain to exactly 36^12 range to guarantee 12-char base36 output
  const BASE12 = 4738381338321616896n;
  n = n % BASE12;
  return `wi_${n.toString(36).padStart(12, "0")}`;
}
