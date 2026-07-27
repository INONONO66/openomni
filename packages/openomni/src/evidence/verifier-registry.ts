export namespace VerifierRegistry {
  export const REF_VERSION = "verifier-ref-v1" as const;

  export type Serializable =
    | null
    | boolean
    | number
    | string
    | Serializable[]
    | { [key: string]: Serializable };

  export const FAMILIES = Object.freeze(["deterministic", "refutation"] as const);

  export type Family = (typeof FAMILIES)[number];
  export type Verdict = "asserted" | "refuted" | "verified";

  export type Request = Readonly<{
    verifierId: string;
    verifierVersion: string;
    input: Serializable;
  }>;

  export type Result = Readonly<{
    version: typeof REF_VERSION;
    verifierId: string;
    verifierVersion: string;
    family: Family;
    checkedPredicate: string;
    verdict: Verdict;
  }>;

  export type RepeatabilityResult = Readonly<{
    result: Result;
    bytes: Uint8Array;
  }>;

  type CatalogEntry = Readonly<{
    verifierId: string;
    verifierVersion: string;
    family: Family;
    checkedPredicate: string;
    verify: (input: Serializable) => Verdict;
  }>;

  export class UnsupportedVerifierError extends Error {
    readonly verifierId: string;
    readonly verifierVersion: string;

    constructor(verifierId: string, verifierVersion: string) {
      super(`Unsupported verifier: ${verifierId}@${verifierVersion}`);
      this.name = "UnsupportedVerifierError";
      this.verifierId = verifierId;
      this.verifierVersion = verifierVersion;
    }
  }

  export class InvalidVerifierInputError extends TypeError {
    constructor(verifierId: string, message: string) {
      super(`Invalid input for ${verifierId}: ${message}`);
      this.name = "InvalidVerifierInputError";
    }
  }

  export class NonSerializableVerifierInputError extends TypeError {
    constructor(message: string) {
      super(message);
      this.name = "NonSerializableVerifierInputError";
    }
  }

  export class NonDeterministicVerifierError extends Error {
    constructor(identity: string) {
      super(`Verifier is not byte-repeatable: ${identity}`);
      this.name = "NonDeterministicVerifierError";
    }
  }

  const EXACT_JSON_ID = "builtin:exact-json";
  const KNOWN_BAD_FIXTURE_ID = "builtin:known-bad-fixture";

  const CATALOG: readonly CatalogEntry[] = Object.freeze([
    Object.freeze({
      verifierId: EXACT_JSON_ID,
      verifierVersion: "1",
      family: "deterministic",
      checkedPredicate: "canonical input equals canonical expected",
      verify(input: Serializable): Verdict {
        const record = requireExactRecord(EXACT_JSON_ID, input, ["actual", "expected"]);
        const actual = record.actual;
        const expected = record.expected;
        if (actual === undefined || expected === undefined) {
          throw new NonSerializableVerifierInputError("$input is not serializable");
        }
        return bytesEqual(canonicalBytes(actual), canonicalBytes(expected))
          ? "verified"
          : "refuted";
      },
    }),
    Object.freeze({
      verifierId: KNOWN_BAD_FIXTURE_ID,
      verifierVersion: "1",
      family: "refutation",
      checkedPredicate: "fixture must not satisfy asserted claim",
      verify(input: Serializable): Verdict {
        const record = requireExactRecord(KNOWN_BAD_FIXTURE_ID, input, ["fixture"]);
        if (typeof record.fixture !== "string") {
          throw new InvalidVerifierInputError(KNOWN_BAD_FIXTURE_ID, "fixture must be a string");
        }
        return record.fixture === "known-bad" ? "refuted" : "asserted";
      },
    }),
  ]);

  const CATALOG_BY_KEY: ReadonlyMap<string, CatalogEntry> = new Map(
    CATALOG.map((entry) => [registrationKey(entry.verifierId, entry.verifierVersion), entry]),
  );

  /** Executes one repository-owned verifier and returns a registry-owned reference. */
  export function verify(request: Request): Result {
    const entry = findEntry(request.verifierId, request.verifierVersion);
    const verdict = entry.verify(normalizeAndFreeze(request.input));
    return createResult(entry, verdict);
  }

  /** Proves that a repository-owned verifier returns the same reference bytes twice. */
  export function assertRepeatable(request: Request): RepeatabilityResult {
    const first = verify(request);
    const firstBytes = canonicalBytes(first);
    const secondBytes = canonicalBytes(verify(request));
    if (!bytesEqual(firstBytes, secondBytes)) {
      throw new NonDeterministicVerifierError(`${request.verifierId}@${request.verifierVersion}`);
    }
    return Object.freeze({ result: first, bytes: firstBytes });
  }

  /** Tests an untrusted function for repeatability without registering it or producing a verifier reference. */
  export function assertFunctionRepeatable(
    candidate: (input: Serializable) => Serializable,
    input: Serializable,
  ): void {
    const first = canonicalBytes(candidate(normalizeAndFreeze(input)));
    const second = canonicalBytes(candidate(normalizeAndFreeze(input)));
    if (!bytesEqual(first, second)) {
      throw new NonDeterministicVerifierError("untrusted candidate");
    }
    return;
  }

  function findEntry(verifierId: string, verifierVersion: string): CatalogEntry {
    const entry = CATALOG_BY_KEY.get(registrationKey(verifierId, verifierVersion));
    if (!entry) throw new UnsupportedVerifierError(verifierId, verifierVersion);
    return entry;
  }

  function createResult(entry: CatalogEntry, verdict: Verdict): Result {
    return Object.freeze({
      version: REF_VERSION,
      verifierId: entry.verifierId,
      verifierVersion: entry.verifierVersion,
      family: entry.family,
      checkedPredicate: entry.checkedPredicate,
      verdict,
    });
  }

  function requireExactRecord(
    verifierId: string,
    input: Serializable,
    expectedKeys: readonly string[],
  ): { [key: string]: Serializable } {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new InvalidVerifierInputError(verifierId, "input must be an object");
    }
    const actualKeys = Object.keys(input);
    if (
      actualKeys.length !== expectedKeys.length ||
      expectedKeys.some((key, index) => actualKeys[index] !== key)
    ) {
      throw new InvalidVerifierInputError(
        verifierId,
        `input must contain exactly: ${expectedKeys.join(", ")}`,
      );
    }
    return input;
  }

  function registrationKey(verifierId: string, verifierVersion: string): string {
    return `${verifierId.length}:${verifierId}${verifierVersion}`;
  }

  function canonicalBytes(value: Serializable): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(normalizeAndFreeze(value)));
  }

  function normalizeAndFreeze(value: Serializable): Serializable {
    return normalize(value, new Set<object>(), "$input");
  }

  function normalize(value: Serializable, ancestors: Set<object>, path: string): Serializable {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new NonSerializableVerifierInputError(`${path} contains a non-finite number`);
      }
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== "object") {
      throw new NonSerializableVerifierInputError(`${path} is not serializable`);
    }
    if (ancestors.has(value)) {
      throw new NonSerializableVerifierInputError(`${path} contains a cycle`);
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (!lengthDescriptor || !("value" in lengthDescriptor)) {
          throw new NonSerializableVerifierInputError(
            `${path}.length must be an own data property`,
          );
        }
        const normalized: Serializable[] = [];
        for (let index = 0; index < lengthDescriptor.value; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor)) {
            throw new NonSerializableVerifierInputError(
              `${path}[${index}] must be an own data property`,
            );
          }
          normalized[index] = normalize(
            descriptor.value as Serializable,
            ancestors,
            `${path}[${index}]`,
          );
        }
        return Object.freeze(normalized) as Serializable;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new NonSerializableVerifierInputError(`${path} must be a plain object`);
      }
      const normalized = Object.create(null) as { [key: string]: Serializable };
      for (const key of Object.keys(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new NonSerializableVerifierInputError(
            `${path}.${key} must be an own data property`,
          );
        }
        Object.defineProperty(normalized, key, {
          value: normalize(descriptor.value as Serializable, ancestors, `${path}.${key}`),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return Object.freeze(normalized);
    } finally {
      ancestors.delete(value);
    }
  }

  function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
}

Object.freeze(VerifierRegistry);
