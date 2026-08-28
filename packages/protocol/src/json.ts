import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Internal single owner for plain-JSON validation and canonical JSON
 * serialization. Not exported from the package barrel: protocol modules
 * import it relatively; external packages consume the domains built on it
 * (policy effects, work-item attempt identity).
 */

export type PlainValue =
  | null
  | boolean
  | number
  | string
  | PlainValue[]
  | { readonly [key: string]: PlainValue };

// Validation at this boundary must never execute caller-supplied code:
// property values are read through data-property descriptors (an accessor
// property is refused without invoking its getter), symbol-keyed own
// properties are refused (JSON serialization would silently drop them),
// and any throw from an exotic object (hostile Proxy trap) is contained by
// the guard and reported as an ordinary parse failure. A fully transparent
// Proxy over plain data is indistinguishable by design — the contract here
// is structural.
function isPlainValueUnsafe(value: unknown): value is PlainValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    // Named own properties make key count exceed length; holes surface as
    // absent index descriptors below — together this refuses sparse arrays,
    // extra properties, and the one-hole + one-named-property cancellation.
    if (Object.keys(value).length !== value.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      if (!isPlainValueUnsafe(descriptor.value)) return false;
    }
    return true;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return false;
    if (!isPlainValueUnsafe(descriptor.value)) return false;
  }
  return true;
}

export function isPlainValue(value: unknown): value is PlainValue {
  try {
    return isPlainValueUnsafe(value);
  } catch {
    return false;
  }
}

export const PlainValueSchema: z.ZodType<PlainValue> = z.custom<PlainValue>(
  (value) => isPlainValue(value),
  { message: "Expected a plain JSON value" },
);

function renderCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON accepts finite numbers only");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => renderCanonical(entry)).join(",")}]`;
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical JSON accepts plain objects only");
    }
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested === undefined) throw new Error(`canonical JSON cannot express undefined at ${key}`);
      fields.push(`${JSON.stringify(key)}:${renderCanonical(nested)}`);
    }
    return `{${fields.join(",")}}`;
  }
  throw new Error(`canonical JSON cannot express a ${typeof value}`);
}

/**
 * ONE digest owner for canonical JSON identity: sorted object keys, no
 * whitespace, finite numbers, plain data only — undefined and non-JSON
 * values fail loudly — hashed with sha256 under the `sha256:` prefix.
 */
export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(renderCanonical(value)).digest("hex")}`;
}
