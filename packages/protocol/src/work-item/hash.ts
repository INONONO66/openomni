export function criterionId(workItemId: string, index: number, statement: string): string {
  return `criterion:${workItemId}:${index}:${stableToken(statement)}`;
}

function stableToken(input: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function generateHash(bytes: Uint8Array): string {
  if (bytes.byteLength !== 8) throw new RangeError("WorkItem ids require exactly 8 entropy bytes");
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  // Cap at 36^12 so toString(36) yields at most 12 chars; padStart below
  // pads shorter values, so the output is always exactly 12 chars.
  const BASE36_POW_12 = 36n ** 12n;
  n = n % BASE36_POW_12;
  return `wi_${n.toString(36).padStart(12, "0")}`;
}
