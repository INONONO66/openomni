import type { PlainValue } from "@openomni/protocol";
import { z } from "zod";

/** JSON.parse preserves -0 and can overflow numbers; the persisted-fact schema rejects both. */
function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && !Number.isNaN(value));
}

function isContainer(value: object): boolean {
  const array = Array.isArray(value);
  return (
    (array || Object.getPrototypeOf(value) === Object.prototype) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    (!array || Object.keys(value).length === value.length)
  );
}

function appendChildren(value: object, pending: unknown[]): boolean {
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
    pending.push(descriptor.value);
  }
  return true;
}

function isPlainValue(input: unknown): input is PlainValue {
  const pending = [input];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (isScalar(value)) continue;
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    if (!isContainer(value) || !appendChildren(value, pending)) return false;
  }
  return true;
}

export const FrameSchema = z.custom<PlainValue>(isPlainValue);
