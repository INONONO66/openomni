import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Internal single owner for plain-JSON validation and canonical JSON
 * serialization. Not exported from the package barrel: protocol modules
 * import it relatively; external packages consume the domains built on it
 * (policy effects, work-item attempt identity).
 */

export type PlainObject = { [key: string]: PlainValue };

export type PlainValue = null | boolean | number | string | PlainValue[] | PlainObject;

// Validation at this boundary must never execute caller-supplied code:
// property values are read through data-property descriptors (an accessor
// property is refused without invoking its getter), symbol-keyed own
// properties are refused (JSON serialization would silently drop them),
// and any throw from an exotic object (hostile Proxy trap) is contained by
// the guard and reported as an ordinary parse failure. A fully transparent
// Proxy over plain data is indistinguishable by design — the contract here
// is structural.
type PlainKeyPolicy = (key: string) => boolean;

const strictPlainKey: PlainKeyPolicy = (key) =>
  key !== "__proto__" && key !== "constructor" && key !== "prototype";
const persistedPlainKey: PlainKeyPolicy = () => true;

function isPlainValueUnsafe(value: unknown, keyPolicy: PlainKeyPolicy): value is PlainValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return isPlainArray(value, keyPolicy);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return isPlainObject(value, keyPolicy);
}

function isPlainArray(value: readonly unknown[], keyPolicy: PlainKeyPolicy): value is PlainValue[] {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  // Named own properties make key count exceed length; holes surface as
  // absent index descriptors below — together this refuses sparse arrays,
  // extra properties, and the one-hole + one-named-property cancellation.
  if (Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor)) return false;
    if (!isPlainValueUnsafe(descriptor.value, keyPolicy)) return false;
  }
  return true;
}

function isPlainObject(value: object, keyPolicy: PlainKeyPolicy): value is PlainObject {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const key of Object.keys(value)) {
    if (!keyPolicy(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return false;
    if (!isPlainValueUnsafe(descriptor.value, keyPolicy)) return false;
  }
  return true;
}

/**
 * Strict live-boundary profile (policy effects): own keys named __proto__,
 * constructor, or prototype are refused outright — hostile input never gets
 * to look like plain data.
 */
export function isPlainValue(value: unknown): value is PlainValue {
  try {
    return isPlainValueUnsafe(value, strictPlainKey);
  } catch {
    return false;
  }
}

/**
 * Persisted-fact profile (work-item attempt identity): identical structural
 * guard, but own keys named __proto__/constructor/prototype are ACCEPTED.
 * Pre-hardening schemas admitted such keys into immutable persisted facts
 * (e.g. attempt fingerprint parameters inside work_item.attempt_allocated),
 * so a read schema that refused them would invalidate historical bytes (era
 * law). Values are only ever READ through data-property descriptors and
 * canonically rendered — never assigned onto another object — so accepting
 * these key names creates no prototype-pollution path here. The remaining
 * strictness deltas vs the old schema (-0, accessor properties, symbol keys,
 * sparse arrays) are unreachable in persisted bytes: rows are written with
 * JSON.stringify (never emits -0) and read with JSON.parse (only dense
 * arrays and plain data properties), so no historical row is invalidated.
 */
export const PlainValueSchema: z.ZodType<PlainValue, PlainValue> = z.custom<PlainValue>(
  (value) => {
    try {
      return isPlainValueUnsafe(value, persistedPlainKey);
    } catch {
      return false;
    }
  },
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
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical JSON accepts plain objects only");
    }
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const nested = (value as PlainObject)[key];
      if (nested === undefined) throw new Error(`canonical JSON cannot express undefined at ${key}`);
      fields.push(`${JSON.stringify(key)}:${renderCanonical(nested)}`);
    }
    return `{${fields.join(",")}}`;
  }
  throw new Error(`canonical JSON cannot express a ${typeof value}`);
}

/**
 * Stable typed-key profile used when canonical JSON values need an in-memory
 * equality key rather than persisted JSON bytes. The primitive tags are an
 * established profile and deliberately remain byte-for-byte compatible with
 * policy conflict keys; accepting values is still owned by the one plain-JSON
 * grammar above.
 */
export function canonicalKey(value: PlainValue): string {
  if (!isPlainValue(value)) throw new Error("canonical key accepts plain JSON values only");
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalKey(value[key] as PlainValue)}`)
      .join(",")}}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

/**
 * ONE digest owner for canonical JSON identity: sorted object keys, no
 * whitespace, finite numbers, plain data only — undefined and non-JSON
 * values fail loudly — hashed with sha256 under the `sha256:` prefix.
 */
export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(renderCanonical(value)).digest("hex")}`;
}
