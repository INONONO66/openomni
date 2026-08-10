import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * #510 C2 — Attempt identity vocabulary.
 *
 * An Attempt is one execution instance of a WorkItem. Per the retained
 * kernel/ledger contract:
 *
 *   - `attemptId` is opaque, immutable, globally unique execution-instance
 *     identity. Consumers never parse it — no format contract beyond
 *     non-emptiness is exposed.
 *   - `attemptSeq` is monotonically allocated per WorkItem by the owner
 *     stream's serialized append (`work:<hash>`) and is never reused.
 *   - `retryOf` is nullable prior-`attemptId` lineage — lineage, never
 *     equivalence: a retry is a NEW attempt that points at its predecessor.
 *   - `contentFingerprint` / `environmentFingerprint` are structured input
 *     records plus the canonical digest those inputs produce; both may
 *     repeat across attempts.
 *   - `reusedFromAttemptId` records a cache hit: the hit CREATES this new
 *     attempt and points at the attempt whose result it reuses.
 *
 * `CacheKey`, `ReplayKey`, and `NondeterminismManifest` ship as dormant
 * vocabulary in C2 (schema only, no lookup implementation) — see
 * docs/implementation-status.md.
 */

// ---------------------------------------------------------------------------
// canonicalization + digest owner
// ---------------------------------------------------------------------------

/**
 * ONE exported digest owner for attempt identity: canonical JSON (sorted
 * object keys, no whitespace, finite numbers, plain data only — undefined
 * and non-JSON values fail loudly) hashed with sha256.
 *
 * TODO(#510 phase D / convention unification): the evidence conformance
 * canonical module (packages/openomni/src/evidence/verifier-conformance-
 * canonical.ts `hashCanonicalJson`) owns an equivalent digest that protocol
 * cannot import (openomni depends on protocol, not the reverse). The
 * restructure audit's digest-owner finding (bare-hex vs `sha256:`-prefixed
 * conventions) already demands convergence — when the canonical module
 * moves below protocol, unify on a single owner.
 */
export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(renderCanonical(value)).digest("hex")}`;
}

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
      if (nested === undefined)
        throw new Error(`canonical JSON cannot express undefined at ${key}`);
      fields.push(`${JSON.stringify(key)}:${renderCanonical(nested)}`);
    }
    return `{${fields.join(",")}}`;
  }
  throw new Error(`canonical JSON cannot express a ${typeof value}`);
}

// ---------------------------------------------------------------------------
// building blocks
// ---------------------------------------------------------------------------

/** Opaque execution-instance identity — no format contract, never parsed. */
export const AttemptId = z.string().min(1).max(128);
export type AttemptId = z.infer<typeof AttemptId>;

/** Mints a fresh opaque attemptId (128 random bits, base36). */
export function generateAttemptId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return `attempt_${n.toString(36)}`;
}

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * Non-reversible reference identity: a digest, or a `ref:`/`version:`
 * identifier. Secrets never appear raw — only their version/reference IDs.
 */
const ReferenceId = z
  .string()
  .max(512)
  .regex(/^(?:sha256:[a-f0-9]{64}|(?:ref|version):[A-Za-z0-9._+/@:-]+)$/);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

/**
 * A declared-but-unavailable fingerprint input. Coverage fields are always
 * required: a best-effort input the caller cannot supply is absent-BUT-
 * LISTED with a reason — never silently empty, never omitted.
 */
const AbsentInput = z.object({ absent: z.literal(true), reason: z.string().min(1) }).strict();
type AbsentInput = z.infer<typeof AbsentInput>;

function declared<Value extends z.ZodTypeAny>(value: Value) {
  return z.union([value, AbsentInput]);
}

function isAbsentInput(value: unknown): value is AbsentInput {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { absent?: unknown }).absent === true &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

const VersionMap = z.record(z.string().min(1), z.union([z.string().min(1), z.number().int()]));

// ---------------------------------------------------------------------------
// fingerprints
// ---------------------------------------------------------------------------

/**
 * Content identity coverage (issue #510): canonical task input, handler/
 * reducer code, model/config, upstream fingerprints, dependency-lock
 * identity. Every slot is required; best-effort slots use absent-but-listed.
 */
export const ContentFingerprintInputs = z
  .object({
    /** Canonical task input — the delegated prompt/goal text. */
    workInput: z.string().min(1),
    /** Which handler executes: the coarse handler identity in hand at spawn. */
    handlerKind: z.string().min(1),
    /** Handler/reducer code identity (build/commit reference). */
    handlerCodeRef: declared(ReferenceId),
    /** Model/config identity. */
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
        parameters: declared(z.record(z.string().min(1), JsonValue)),
      })
      .strict(),
    /**
     * Fingerprints of upstream attempts this attempt consumes: a NON-EMPTY
     * list, or absent-but-listed with a reason. A bare `[]` is rejected — a
     * caller that consumed nothing declares that fact instead of leaving a
     * silently-empty slot indistinguishable from "not captured".
     */
    upstreamFingerprints: declared(z.array(Digest).min(1)),
    /** Dependency-lock identity. */
    dependencyLock: declared(ReferenceId),
  })
  .strict();
export type ContentFingerprintInputs = z.infer<typeof ContentFingerprintInputs>;

/**
 * Environment identity coverage (issue #510): runtime/OS/architecture,
 * dependency/tool/policy/verifier/schema versions, provider/model
 * parameters, redacted config identity — non-reversible secret version/
 * reference IDs only.
 */
export const EnvironmentFingerprintInputs = z
  .object({
    os: z.string().min(1),
    arch: z.string().min(1),
    bunVersion: z.string().min(1),
    workspaceRoot: declared(z.string().min(1)),
    schemaVersions: VersionMap,
    policy: declared(
      z
        .object({
          labels: z.array(z.string().min(1)),
          registryVersion: z.string().min(1).optional(),
        })
        .strict(),
    ),
    toolVersions: declared(VersionMap),
    verifierVersions: declared(VersionMap),
    providerParameters: declared(z.record(z.string().min(1), JsonValue)),
    /** Redacted config identity — non-reversible version/reference IDs only. */
    configRef: declared(ReferenceId),
  })
  .strict();
export type EnvironmentFingerprintInputs = z.infer<typeof EnvironmentFingerprintInputs>;

function fingerprintOf<Inputs extends z.ZodTypeAny>(inputs: Inputs) {
  return z
    .object({ inputs, digest: Digest })
    .strict()
    .superRefine((fingerprint, ctx) => {
      if (fingerprint.digest !== canonicalDigest(fingerprint.inputs)) {
        ctx.addIssue({
          code: "custom",
          message: "fingerprint digest does not match its canonical inputs",
          path: ["digest"],
        });
      }
    });
}

/** Structured content inputs plus the canonical digest they produce. May repeat. */
export const ContentFingerprint = fingerprintOf(ContentFingerprintInputs);
export type ContentFingerprint = z.infer<typeof ContentFingerprint>;

/** Structured environment inputs plus the canonical digest they produce. May repeat. */
export const EnvironmentFingerprint = fingerprintOf(EnvironmentFingerprintInputs);
export type EnvironmentFingerprint = z.infer<typeof EnvironmentFingerprint>;

export function contentFingerprintOf(
  inputs: z.input<typeof ContentFingerprintInputs>,
): ContentFingerprint {
  const parsed = ContentFingerprintInputs.parse(inputs);
  return { inputs: parsed, digest: canonicalDigest(parsed) };
}

export function environmentFingerprintOf(
  inputs: z.input<typeof EnvironmentFingerprintInputs>,
): EnvironmentFingerprint {
  const parsed = EnvironmentFingerprintInputs.parse(inputs);
  return { inputs: parsed, digest: canonicalDigest(parsed) };
}

// ---------------------------------------------------------------------------
// attempt identity
// ---------------------------------------------------------------------------

export const Attempt = z
  .object({
    attemptId: AttemptId,
    attemptSeq: z.number().int().positive(),
    retryOf: AttemptId.nullable(),
    contentFingerprint: ContentFingerprint,
    environmentFingerprint: EnvironmentFingerprint,
    /** Set by a cache hit: the hit creates THIS new attempt and records the reused one. */
    reusedFromAttemptId: AttemptId.nullable(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.retryOf === attempt.attemptId) {
      ctx.addIssue({
        code: "custom",
        message: "retryOf is prior-attempt lineage — an attempt cannot retry itself",
        path: ["retryOf"],
      });
    }
    if (attempt.attemptSeq === 1 && attempt.retryOf !== null) {
      ctx.addIssue({
        code: "custom",
        message: "the first attempt of a WorkItem has no prior lineage",
        path: ["retryOf"],
      });
    }
    if (attempt.reusedFromAttemptId === attempt.attemptId) {
      ctx.addIssue({
        code: "custom",
        message: "a cache hit records the prior attempt — an attempt cannot reuse itself",
        path: ["reusedFromAttemptId"],
      });
    }
  });
export type Attempt = z.infer<typeof Attempt>;

// ---------------------------------------------------------------------------
// attempt terminal record (#510 D2b — worker-run cutover)
// ---------------------------------------------------------------------------

/**
 * Terminal outcome vocabulary of ONE attempt execution. This is the honest
 * fold of the retired worker-run terminal states (`succeeded`/`failed`/
 * `cancelled`/`interrupted`) onto the attempt lifecycle; the non-terminal
 * worker-run states have existing homes in the WorkItem fold (started ↔
 * running, waiting_input ↔ unresolved `waiting_input` blocker).
 */
export const AttemptOutcome = z.enum(["succeeded", "failed", "cancelled", "interrupted"]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/**
 * #510 D2b — projection of the `work_item.attempt_finished` decision-class
 * fact: the current attempt's terminal record. `endedAt` and
 * `lastMessageId` moved here from the worker-run store's in-memory
 * `runExtras` map (lost on restart before the cutover) — they are attempt
 * lifecycle data with no other home in the WorkItem vocabulary. Cleared by
 * the next `work_item.attempt_allocated` fact (a new execution instance).
 */
export const AttemptTerminal = z
  .object({
    attemptId: AttemptId,
    outcome: AttemptOutcome,
    endedAt: z.number(),
    lastMessageId: z.string().min(1).optional(),
    error: z.string().optional(),
  })
  .strict();
export type AttemptTerminal = z.infer<typeof AttemptTerminal>;

// ---------------------------------------------------------------------------
// cacheKey — dormant vocabulary (schema only in C2)
// ---------------------------------------------------------------------------

const environmentInputFields = Object.keys(EnvironmentFingerprintInputs.shape) as [
  keyof typeof EnvironmentFingerprintInputs.shape,
  ...(keyof typeof EnvironmentFingerprintInputs.shape)[],
];

/** Field names of EnvironmentFingerprintInputs eligible for a cacheKey subset. */
export const EnvironmentSubsetField = z.enum(environmentInputFields);
export type EnvironmentSubsetField = z.infer<typeof EnvironmentSubsetField>;

/**
 * Explicit cache lookup key: content fingerprint digest plus a DECLARED
 * deterministic environment subset. Never a row key — it carries no
 * attemptId and `key` is derived (a tampered key fails the refine). A hit
 * creates a NEW attempt and records `reusedFromAttemptId` on it.
 */
export const CacheKey = z
  .object({
    contentDigest: Digest,
    /** Declared deterministic environment subset (sorted, unique field names). */
    environmentSubset: z.array(EnvironmentSubsetField).min(1),
    environmentSubsetDigest: Digest,
    key: Digest,
  })
  .strict()
  .superRefine((cacheKey, ctx) => {
    const sorted = [...new Set(cacheKey.environmentSubset)].sort();
    if (sorted.join(",") !== cacheKey.environmentSubset.join(",")) {
      ctx.addIssue({
        code: "custom",
        message: "environment subset must be sorted and unique",
        path: ["environmentSubset"],
      });
      return;
    }
    const derived = canonicalDigest({
      contentDigest: cacheKey.contentDigest,
      environmentSubset: cacheKey.environmentSubset,
      environmentSubsetDigest: cacheKey.environmentSubsetDigest,
    });
    if (cacheKey.key !== derived) {
      ctx.addIssue({
        code: "custom",
        message: "cacheKey is derived from its components, never assigned",
        path: ["key"],
      });
    }
  });
export type CacheKey = z.infer<typeof CacheKey>;

/**
 * Derives the cache lookup key. Every subset field must be PRESENT in the
 * environment inputs — a declared-absent input is not deterministic and
 * fails loudly.
 */
export function cacheKeyOf(
  content: ContentFingerprint,
  environment: EnvironmentFingerprint,
  subset: readonly EnvironmentSubsetField[],
): CacheKey {
  const fields = [...new Set(subset)].sort();
  if (fields.length === 0) throw new Error("cacheKey requires a declared environment subset");
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    const input = environment.inputs[field];
    if (isAbsentInput(input)) {
      throw new Error(
        `cacheKey requires a deterministic environment subset — "${field}" is declared absent (${input.reason})`,
      );
    }
    picked[field] = input;
  }
  const environmentSubsetDigest = canonicalDigest(picked);
  return CacheKey.parse({
    contentDigest: content.digest,
    environmentSubset: fields,
    environmentSubsetDigest,
    key: canonicalDigest({
      contentDigest: content.digest,
      environmentSubset: fields,
      environmentSubsetDigest,
    }),
  });
}

// ---------------------------------------------------------------------------
// replayKey — dormant vocabulary (schema only in C2)
// ---------------------------------------------------------------------------

/**
 * Replay-of-record binding ONLY: an immutable archived range/cassette,
 * the environment fingerprint digest, schema/upcast versions, and the
 * nondeterminism-manifest digest. It carries NO content fingerprint, so it
 * structurally cannot express a cache lookup — never a cache key. An
 * incompatible environment or upcast fails loudly at the (phase D) replay
 * boundary; a what-if/fork is a separately labeled NEW attempt.
 */
export const ReplayKey = z
  .object({
    archivedRange: z
      .object({
        streamId: z.string().min(1),
        fromSeq: z.number().int().positive(),
        toSeq: z.number().int().positive(),
        /** Integrity hash of the archived range identity. */
        integrityDigest: Digest,
      })
      .strict(),
    environmentDigest: Digest,
    schemaVersions: VersionMap,
    upcastVersions: VersionMap,
    nondeterminismManifestDigest: Digest,
  })
  .strict()
  .superRefine((replayKey, ctx) => {
    if (replayKey.archivedRange.toSeq < replayKey.archivedRange.fromSeq) {
      ctx.addIssue({
        code: "custom",
        message: "an archived range cannot end before it starts",
        path: ["archivedRange", "toSeq"],
      });
    }
  });
export type ReplayKey = z.infer<typeof ReplayKey>;

// ---------------------------------------------------------------------------
// nondeterminism manifest — dormant vocabulary (schema only in C2)
// ---------------------------------------------------------------------------

/**
 * The issue's enumerated nondeterminism categories: consumed clocks/time
 * zones, random seeds/bytes, model sampling/output/provider request ID,
 * network/tool/device responses, ordering/concurrency choices, generated
 * IDs, environment reads, and human/source inputs.
 */
export const NondeterminismCategory = z.enum([
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
]);
export type NondeterminismCategory = z.infer<typeof NondeterminismCategory>;

const ManifestRecording = z
  .object({
    category: NondeterminismCategory,
    /** Redacted provenance/version reference — secrets never appear raw. */
    identifier: ReferenceId,
    value: JsonValue,
  })
  .strict();

const ManifestAbsence = z
  .object({
    category: NondeterminismCategory,
    reason: z.string().min(1),
  })
  .strict();

/**
 * Fail-loud coverage: EVERY category is either recorded or declared absent
 * with a reason. A category that is neither recorded nor listed rejects —
 * declared-but-absent inputs are listed, never silently omitted.
 */
export const NondeterminismManifest = z
  .object({
    recorded: z.array(ManifestRecording),
    absent: z.array(ManifestAbsence),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const recorded = new Set(manifest.recorded.map((entry) => entry.category));
    const absent = new Set(manifest.absent.map((entry) => entry.category));
    if (absent.size !== manifest.absent.length) {
      ctx.addIssue({
        code: "custom",
        message: "a category is declared absent more than once",
        path: ["absent"],
      });
    }
    for (const category of NondeterminismCategory.options) {
      if (!recorded.has(category) && !absent.has(category)) {
        ctx.addIssue({
          code: "custom",
          message: `nondeterminism input "${category}" is neither recorded nor declared absent with a reason — missing manifest input fails loudly`,
          path: ["absent"],
        });
      }
      if (recorded.has(category) && absent.has(category)) {
        ctx.addIssue({
          code: "custom",
          message: `nondeterminism input "${category}" cannot be both recorded and declared absent`,
          path: ["absent"],
        });
      }
    }
  });
export type NondeterminismManifest = z.infer<typeof NondeterminismManifest>;
