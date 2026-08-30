export function flattenRecord(record: Record<string, unknown>, prefix = ""): [string, unknown][] {
  const fields: [string, unknown][] = [];

  for (const key of Object.keys(record).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = record[key];

    if (isRecord(value) && Object.keys(value).length > 0) {
      fields.push(...flattenRecord(value, path));
      continue;
    }

    fields.push([path, value]);
  }

  return fields;
}

export function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

export function deepMergeRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? deepMergeRecords(current, value) : value;
  }

  return result;
}

export function stableKey(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return `${typeof value}:${JSON.stringify(value)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled policy effect: ${stableStringify(value)}`);
}
