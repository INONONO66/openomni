/**
 * Restores Date fields lost during JSON round-trip.
 * JSON.stringify converts Date → string; this converts back.
 */
export function normalizePlanPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.createdAt !== "string") return payload;

  const parsedDate = new Date(candidate.createdAt);
  if (Number.isNaN(parsedDate.getTime())) return payload;

  return { ...candidate, createdAt: parsedDate };
}

export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}
