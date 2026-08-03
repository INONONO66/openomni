import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
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
const MAX_JSON_CODE_UNITS = 7_340_032;
const forbiddenJsonKeys = new Set(["__proto__", "constructor", "prototype"]);

export const JsonValueSchema = z
  .unknown()
  .transform<JsonValue>((value, context) => snapshotJsonInput(value, context));
export const JsonObjectSchema = z.unknown().transform<JsonObject>((value, context) => {
  try {
    const snapshot = snapshotJson(value, 0, {
      active: new WeakSet<object>(),
      codeUnits: 0,
      nodes: 0,
    });
    if (!isJsonRecord(snapshot)) failSnapshot();
    return snapshot;
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "expected bounded plain JSON object",
    });
    return z.NEVER;
  }
});
export const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const RedactedIdentifierSchema = z
  .string()
  .max(512)
  .regex(/^(?:sha256:[a-f0-9]{64}|(?:ref|version):[A-Za-z0-9._+/@-]+)$/);

export function canonicalJson(input: unknown): string {
  return renderCanonical(snapshotJsonValue(input));
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
  return snapshotJsonValue(value);
}

export const EnvironmentFingerprintInputSchema = JsonValueSchema.pipe(
  z
    .object({
      runtimeIdentifiers: z.array(RedactedIdentifierSchema).min(1).max(256),
      dependencyIdentifiers: z.array(RedactedIdentifierSchema).max(256),
      environmentIdentifiers: z.array(RedactedIdentifierSchema).max(256),
    })
    .strict(),
);
export const EnvironmentFingerprintSchema = z
  .object({
    version: z.literal("environment-fingerprint-v1"),
    runtimeFingerprint: Sha256DigestSchema,
    dependencyFingerprint: Sha256DigestSchema,
    environmentFingerprint: Sha256DigestSchema,
    fingerprint: Sha256DigestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.fingerprint !== environmentAggregateFingerprint(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "environment aggregate fingerprint does not match its components",
      });
    }
  });
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
      fingerprint: environmentAggregateFingerprint({
        version: "environment-fingerprint-v1",
        runtimeFingerprint,
        dependencyFingerprint,
        environmentFingerprint,
      }),
    }),
  );
}

function environmentAggregateFingerprint(
  value: Readonly<{
    version: "environment-fingerprint-v1";
    runtimeFingerprint: string;
    dependencyFingerprint: string;
    environmentFingerprint: string;
  }>,
): string {
  return hashCanonicalJson({
    version: value.version,
    runtimeFingerprint: value.runtimeFingerprint,
    dependencyFingerprint: value.dependencyFingerprint,
    environmentFingerprint: value.environmentFingerprint,
  });
}

export const NondeterminismManifestSchema = JsonValueSchema.pipe(
  z
    .object({
      version: z.literal("nondeterminism-manifest-v1"),
      entries: z
        .array(
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
        )
        .max(1_024),
    })
    .strict(),
);

export function hashNondeterminismManifest(input: unknown): string {
  return hashCanonicalJson(NondeterminismManifestSchema.parse(input));
}

function isJsonRecord(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type SnapshotState = {
  readonly active: WeakSet<object>;
  codeUnits: number;
  nodes: number;
};

function failSnapshot(): never {
  throw new Error("expected bounded plain JSON data");
}

function accountSnapshot(state: SnapshotState, codeUnits = 1): void {
  state.nodes += 1;
  state.codeUnits += codeUnits;
  if (state.nodes > MAX_JSON_NODES || state.codeUnits > MAX_JSON_CODE_UNITS) failSnapshot();
}

function snapshotJson(value: unknown, depth: number, state: SnapshotState): JsonValue {
  if (depth > MAX_JSON_DEPTH) failSnapshot();
  if (value === null) {
    accountSnapshot(state, 4);
    return null;
  }
  if (typeof value === "boolean") {
    accountSnapshot(state, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      failSnapshot();
    }
    accountSnapshot(state, String(value).length);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) failSnapshot();
    accountSnapshot(state, value.length);
    return value;
  }
  if (typeof value !== "object" || isProxy(value) || state.active.has(value)) failSnapshot();
  state.active.add(value);
  accountSnapshot(state);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) failSnapshot();
      if (value.length > MAX_JSON_COLLECTION_ENTRIES) failSnapshot();
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys.some((key) => typeof key !== "string") ||
        keys[value.length] !== "length"
      ) {
        failSnapshot();
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (keys[index] !== key) failSnapshot();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          failSnapshot();
        }
        output.push(snapshotJson(descriptor.value, depth + 1, state));
      }
      return Object.freeze(output);
    }
    if (!isJsonRecord(value)) failSnapshot();
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_JSON_COLLECTION_ENTRIES || keys.some((key) => typeof key !== "string")) {
      failSnapshot();
    }
    const output: Record<string, JsonValue> = Object.create(null);
    for (const key of keys as string[]) {
      if (forbiddenJsonKeys.has(key) || key.length > MAX_JSON_STRING_LENGTH) failSnapshot();
      accountSnapshot(state, key.length);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        failSnapshot();
      }
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: snapshotJson(descriptor.value, depth + 1, state),
        writable: false,
      });
    }
    return Object.freeze(output);
  } finally {
    state.active.delete(value);
  }
}

function snapshotJsonInput(value: unknown, context: z.RefinementCtx): JsonValue | typeof z.NEVER {
  try {
    return snapshotJsonValue(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "expected bounded plain JSON data",
    });
    return z.NEVER;
  }
}

export function snapshotJsonValue(value: unknown): JsonValue {
  return snapshotJson(value, 0, {
    active: new WeakSet<object>(),
    codeUnits: 0,
    nodes: 0,
  });
}
