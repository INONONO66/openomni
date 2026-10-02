import type { PlainValue } from "@openomni/protocol";

export function clonePlain(value: PlainValue): PlainValue {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePlain(item)]));
}

export function freezePlain(value: PlainValue): PlainValue {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezePlain(item);
    Object.freeze(value);
  }
  return value;
}
