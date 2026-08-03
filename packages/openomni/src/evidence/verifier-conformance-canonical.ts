import { createHash } from "node:crypto";
import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
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
  if (isJsonArray(value)) {
    for (const nested of value) freezeJson(nested);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const nested = value[key];
      if (nested !== undefined) freezeJson(nested);
    }
  }
  Object.freeze(value);
  return value;
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
