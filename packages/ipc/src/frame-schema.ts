import type { PlainValue } from "@openomni/protocol";
import { z } from "zod";

/** JSON.parse preserves -0 and can overflow numbers; the persisted-fact schema rejects both. */
export const FrameSchema = z.custom<PlainValue>(isFrameValue);

type FrameEntry = boolean | object;

function frameEntry<T>(value: T): FrameEntry {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number" && !Number.isNaN(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  return value;
}

function isFrameValue<T>(input: T): boolean {
  const pending: FrameEntry[] = [frameEntry(input)];
  const seen = new Set<object>();
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    if (entry === true) continue;
    if (entry === false) return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
    if (!isContainer(entry)) return false;
    for (const key of Object.keys(entry)) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !("value" in descriptor)) return false;
      pending.push(frameEntry(descriptor.value));
    }
  }
  return true;
}

function isContainer(value: object): boolean {
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  if (array && Object.keys(value).length !== value.length) return false;
  return true;
}
