import { createHash } from "node:crypto";
import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_COLLECTION_ENTRIES = 10_000;
const MAX_JSON_STRING_LENGTH = 1_048_576;
const forbiddenJsonKeys = new Set(["__proto__", "constructor", "prototype"]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  (value) => isJsonValue(value),
  { message: "expected bounded plain JSON data" },
);
export const JsonObjectSchema: z.ZodType<JsonObject> = z.custom<JsonObject>(
  (value) => isJsonRecord(value) && isJsonValue(value),
  { message: "expected bounded plain JSON object" },
);
export const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const RedactedIdentifierSchema = z
  .string()
  .regex(/^(?:sha256:[a-f0-9]{64}|(?:ref|version):[A-Za-z0-9._+/@-]+)$/);

export function canonicalJson(input: unknown): string {
  return renderCanonical(JsonValueSchema.parse(input));
}

export function hashCanonicalJson(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function renderCanonical(value: JsonValue): string {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (typeof value === "string") {
    const rendered = JSON.stringify(value);
    if (rendered === undefined) throw new Error("JSON string could not be rendered");
    return rendered;
  }
  if (isJsonArray(value)) return `[${value.map(renderCanonical).join(",")}]`;
  const fields: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const nested = value[key];
    if (nested === undefined) throw new Error(`non-JSON value at ${key}`);
    fields.push(`${JSON.stringify(key)}:${renderCanonical(nested)}`);
  }
  return `{${fields.join(",")}}`;
}

export function freezeJson(value: JsonValue): JsonValue {
  return freezeValidatedJson(JsonValueSchema.parse(value));
}

export const EnvironmentFingerprintInputSchema = z
  .object({
    runtimeIdentifiers: z.array(RedactedIdentifierSchema).min(1),
    dependencyIdentifiers: z.array(RedactedIdentifierSchema),
    environmentIdentifiers: z.array(RedactedIdentifierSchema),
  })
  .strict();
export const EnvironmentFingerprintSchema = z
  .object({
    version: z.literal("environment-fingerprint-v1"),
    runtimeFingerprint: Sha256DigestSchema,
    dependencyFingerprint: Sha256DigestSchema,
    environmentFingerprint: Sha256DigestSchema,
    fingerprint: Sha256DigestSchema,
  })
  .strict();
export type EnvironmentFingerprint = Readonly<z.infer<typeof EnvironmentFingerprintSchema>>;

export function createEnvironmentFingerprint(input: unknown): EnvironmentFingerprint {
  const parsed = EnvironmentFingerprintInputSchema.parse(input);
  const runtimeFingerprint = hashCanonicalJson([...parsed.runtimeIdentifiers].sort());
  const dependencyFingerprint = hashCanonicalJson([...parsed.dependencyIdentifiers].sort());
  const environmentFingerprint = hashCanonicalJson([...parsed.environmentIdentifiers].sort());
  return Object.freeze(
    EnvironmentFingerprintSchema.parse({
      version: "environment-fingerprint-v1",
      runtimeFingerprint,
      dependencyFingerprint,
      environmentFingerprint,
      fingerprint: hashCanonicalJson({
        runtimeFingerprint,
        dependencyFingerprint,
        environmentFingerprint,
      }),
    }),
  );
}

export const NondeterminismManifestSchema = z
  .object({
    version: z.literal("nondeterminism-manifest-v1"),
    entries: z.array(
      z
        .object({
          kind: z.enum([
            "clock",
            "time_zone",
            "random",
            "model",
            "network",
            "tool",
            "device",
            "ordering",
            "generated_id",
            "environment",
            "human",
            "source",
          ]),
          identifier: RedactedIdentifierSchema,
          value: JsonValueSchema,
        })
        .strict(),
    ),
  })
  .strict();

export function hashNondeterminismManifest(input: unknown): string {
  return hashCanonicalJson(NondeterminismManifestSchema.parse(input));
}

function isJsonValue(value: unknown): value is JsonValue {
  return validateJsonValue(value, 0, { nodes: 0, active: new WeakSet<object>() });
}

function validateJsonValue(
  value: unknown,
  depth: number,
  state: { nodes: number; active: WeakSet<object> },
): value is JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MAX_JSON_STRING_LENGTH;
  if (typeof value !== "object") return false;
  if (state.active.has(value)) return false;

  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_JSON_COLLECTION_ENTRIES
    ) {
      return false;
    }
    state.active.add(value);
    const valid = value.every((nested) => validateJsonValue(nested, depth + 1, state));
    state.active.delete(value);
    return valid;
  }
  if (!isJsonRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_JSON_COLLECTION_ENTRIES || keys.some((key) => typeof key !== "string")) {
    return false;
  }
  state.active.add(value);
  for (const key of keys as string[]) {
    if (forbiddenJsonKeys.has(key)) {
      state.active.delete(value);
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !validateJsonValue(descriptor.value, depth + 1, state)
    ) {
      state.active.delete(value);
      return false;
    }
  }
  state.active.delete(value);
  return true;
}

function isJsonRecord(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeValidatedJson(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    for (const nested of value) freezeValidatedJson(nested);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const nested = value[key];
      if (nested !== undefined) freezeValidatedJson(nested);
    }
  }
  Object.freeze(value);
  return value;
}
