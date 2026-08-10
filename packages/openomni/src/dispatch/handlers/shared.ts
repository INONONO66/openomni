// Inbound payload-text parsing is owned by ingress (the boundary that mints
// the payload shape): import extractText from ../../ingress/handlers.js.

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
