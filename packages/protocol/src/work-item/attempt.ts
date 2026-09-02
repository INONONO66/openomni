import { z } from "zod";
import { canonicalDigest, PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";

/**
 * #510 C2 — Attempt identity vocabulary.
 *
 * An Attempt is one execution instance of a WorkItem. Per the retained
 * kernel/ledger contract (see also `AttemptOutcome` below for the #807
 * `unverified` outcome):
 *
 *   - `attemptId` is opaque, immutable, globally unique execution-instance
 *     identity. Consumers never parse it — no format contract beyond
 *     non-emptiness is exposed.
 *   - `attemptSeq` is monotonically allocated per WorkItem by the owner
 *     stream's serialized append (`work:<workItemId>`) and is never reused.
 *   - `retryOf` is nullable prior-`attemptId` lineage — lineage, never
 *     equivalence: a retry is a NEW attempt that points at its predecessor.
 *   - `contentFingerprint` / `environmentFingerprint` are structured input
 *     records plus the canonical digest those inputs produce; both may
 *     repeat across attempts.
 *   - `reusedFromAttemptId` records a cache hit: the hit CREATES this new
 *     attempt and points at the attempt whose result it reuses.
 */

// Attempt identity digests come from the internal canonical-JSON owner
// (../json). Re-exported so WorkItem.canonicalDigest keeps its public seat.
export { canonicalDigest };

/** Opaque execution-instance identity — no format contract, never parsed. */
export const AttemptId = z.string().min(1).max(128);
export type AttemptId = z.infer<typeof AttemptId>;

/** Encodes exactly 128 caller-supplied entropy bits in the persisted base36 grammar. */
export function generateAttemptId(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new RangeError("attempt ids require exactly 16 entropy bytes");
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

// Plain-JSON values share the hardened internal owner (../json): accessor
// properties, symbol keys, prototype-key smuggling, sparse arrays, and -0
// are refused — everything a JSON round-trip produces still passes, so
// persisted fingerprints keep parsing across eras.
const JsonValue = PlainValueSchema;

/**
 * A declared-but-unavailable fingerprint input. Coverage fields are always
 * required: a best-effort input the caller cannot supply is absent-BUT-
 * LISTED with a reason — never silently empty, never omitted.
 */
const AbsentInput = z.object({ absent: z.literal(true), reason: z.string().min(1) }).strict();

function declared<Value extends z.ZodTypeAny>(value: Value) {
  return z.union([value, AbsentInput]);
}

const VersionMap = z.record(z.string().min(1), z.union([z.string().min(1), z.number().int()]));

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

function fingerprintOf<Inputs extends z.ZodType>(inputs: Inputs) {
  return z
    .object({ inputs, digest: Digest })
    .strict()
    .superRefine((value, ctx) => {
      // The generic `Inputs` keeps TS from resolving the mapped output shape;
      // both fields are structurally guaranteed by the object schema above.
      const fingerprint = value as { inputs: unknown; digest: string };
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
 *
 * #807 adds `unverified`: the attempt's executor reported completion and
 * nothing checked it. It is deliberately NOT folded onto succeeded (no check
 * confirmed the work) nor onto failed (no check refuted it either) — an
 * unverified attempt records the absence of a verdict as its own fact.
 */
export const AttemptOutcome = z.enum([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "unverified",
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/** Transport-reported spend. Visibility only — never an admission input. */
export const AttemptUsage = z
  .object({
    tokens: z.number().int().nonnegative().optional(),
    seconds: z.number().nonnegative(),
  })
  .strict();
export type AttemptUsage = z.infer<typeof AttemptUsage>;

/**
 * #510 D2b — projection of the `work_item.attempt_finished` decision-class
 * fact: the current attempt's terminal record. `endedAt`/`error` moved here
 * from the worker-run store (whose in-memory extras map lost them on
 * restart) — attempt lifecycle data with no other home in the WorkItem
 * vocabulary. Cleared by the next `work_item.attempt_allocated` fact (a new
 * execution instance). The legacy `lastMessageId` extra was NOT carried
 * over: it never had a production writer, so it earns no vocabulary here.
 */
export const AttemptTerminal = z
  .object({
    attemptId: AttemptId,
    /** Worker run that produced the terminal outcome, distinct across driven reruns. */
    workerRunId: z.string().min(1).optional(),
    outcome: AttemptOutcome,
    endedAt: EpochMs,
    error: z.string().optional(),
    usage: AttemptUsage.optional(),
  })
  .strict();
export type AttemptTerminal = z.infer<typeof AttemptTerminal>;
