import type { PlainValue } from "@openomni/protocol";
import { z } from "zod";

/** JSON.parse preserves -0 and can overflow numbers; the persisted-fact schema rejects both. */
export const FrameSchema = z.custom<PlainValue>((input) => {
  const pending = [input];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && !Number.isNaN(value)) continue;
    if (typeof value !== "object" || value === null) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    if (array && Object.keys(value).length !== value.length) return false;
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
});
