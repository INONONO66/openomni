export function extractPrompt(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (
    payload &&
    typeof payload === "object" &&
    "text" in payload &&
    typeof (payload as { text: unknown }).text === "string"
  ) {
    return (payload as { text: string }).text;
  }
  return JSON.stringify(payload);
}
