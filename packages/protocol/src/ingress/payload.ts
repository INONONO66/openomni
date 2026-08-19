/**
 * THE canonical inbound payload-text parser (#707 stage-2 hoist from the
 * kernel ingress handlers): a string payload is the text, a `{ text: string }`
 * envelope unwraps, anything else round-trips through JSON (nullish and
 * non-serializable payloads fail safe to ""). The payload shape is minted at
 * the perimeter and consumed by the brain — one pure parser in protocol keeps
 * both sides byte-identical instead of drifting copies.
 */
export function extractText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (
    payload &&
    typeof payload === "object" &&
    "text" in payload &&
    typeof (payload as { text?: unknown }).text === "string"
  ) {
    return (payload as { text: string }).text;
  }
  if (payload === null || payload === undefined) return "";
  return JSON.stringify(payload) ?? "";
}
