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
