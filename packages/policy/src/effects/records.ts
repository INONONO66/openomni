import { canonicalKey, type PlainObject, type PlainValue } from "@openomni/protocol";

export function flattenRecord(record: PlainObject, prefix = ""): [string, PlainValue][] {
  const fields: [string, PlainValue][] = [];

  for (const key of Object.keys(record).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = record[key] as PlainValue;

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

export function deepMergeRecords(left: PlainObject, right: PlainObject): PlainObject {
  const result: PlainObject = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? deepMergeRecords(current, value) : value;
  }

  return result;
}

export function stableKey(value: PlainValue): string {
  return canonicalKey(value);
}

function isRecord(value: PlainValue | undefined): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
