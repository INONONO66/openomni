export function categoryOf(eventName: string): string {
  return eventName.split(".", 1)[0] || "custom";
}

export function getTraceField(value: unknown, key: string): string | undefined {
  const root = toRecord(value);
  if (!root) return undefined;
  return (
    stringFromRecord(root, key) ??
    stringFromRecord(toRecord(root.payload), key) ??
    stringFromRecord(toRecord(root.traceContext), key)
  );
}

export function getNumberTraceField(value: unknown, key: string): number | undefined {
  const root = toRecord(value);
  if (!root) return undefined;
  return (
    numberFromRecord(root, key) ??
    numberFromRecord(toRecord(root.payload), key) ??
    numberFromRecord(toRecord(root.traceContext), key)
  );
}

export function stringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

export function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? (value as Record<string, unknown>)
    : undefined;
}
