import { WorkItem } from "@openomni/protocol";
import { z } from "zod";

/**
 * #493 I1 — the deterministic flat-event PROJECTION SPINE.
 *
 * A `FlatEvent` is one denormalized, replay-shaped row: a single per-step
 * fact bundle flattened onto a fixed 30-column schema so projections, export
 * (JSONL), and deterministic replay all read the SAME row shape. This module
 * owns three PURE pieces and nothing else — no I/O, no clock, no LLM:
 *
 *   1. the `FlatEvent` zod schema (30 fields, fixed order);
 *   2. `mapVerdict` — a pure map from the verifier registry status vocabulary
 *      onto `ok | warn | error`, throw-on-unknown (fail loud);
 *   3. `foldToFlatEvents` — maps an assembled, fully-populated intermediate
 *      `ProjectionInput` into a deterministically ordered `FlatEvent[]`.
 *
 * AUTHORITY SOURCE — NOT bus_event. Every authoritative field is assembled
 * from the WorkItem attempt ledger facts (`work_item.attempt_allocated`, the
 * immutable Attempt identity — packages/session/src/work-item/facts.ts) plus
 * the append-only `transcript_fact` rows (migration 0015). It is NEVER read
 * from `bus_event`, which is telemetry-tier, lossy, and destroys raw bodies
 * via `redactForPersistence`. `ProjectionInput` is the already-assembled
 * intermediate; this fold is a pure function over it.
 *
 * LATER-INCREMENT INPUTS — carried through, never invented. Five columns are
 * produced by runtime writers that land in later increments and are simply
 * carried through from `ProjectionInput`:
 *
 *   - `prompt_hash`, `observation_hash`  → I3 evidence/prompt sidecars;
 *   - `cache_key`, `replay_key`, `nondeterminism_manifest_hash`
 *                                        → I2 replay-identity writers.
 *
 * This fold maps whatever the input provides for those five; it does NOT
 * fabricate them (a step with no sidecar carries `null`). Likewise, PRODUCTION
 * fingerprint richness — the `absent-but-listed` spawn-site inputs behind
 * `content_fingerprint` / `environment_fingerprint` (protocol
 * `ContentFingerprintInputs` / `EnvironmentFingerprintInputs`) — is upstream
 * #510 phase-D scope and is NOT papered over here: this fold emits the SCALAR
 * `.digest` the attempt already recorded, whatever its input coverage.
 */

// ---------------------------------------------------------------------------
// scalar building blocks
// ---------------------------------------------------------------------------

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

/** Denormalized outcome of one step. Distinct from the verifier status. */
export const Verdict = z.enum(["ok", "warn", "error"]);
export type Verdict = z.infer<typeof Verdict>;

/**
 * The verifier registry status vocabulary (single source of truth:
 * `VerifierRegistry.ResultStatus`, packages/openomni/src/evidence/
 * verifier-registry-contract.ts, mirrored by protocol `ResultValue`). A step
 * with no verification carries `null` (see `ProjectionStep.verifierStatus`).
 */
const VerifierStatus = z.enum(["verified", "refuted", "inconclusive", "asserted"]);

// ---------------------------------------------------------------------------
// verdict mapper — PURE, throw-on-unknown
// ---------------------------------------------------------------------------

/**
 * Maps a recorded verifier status onto the flat-event verdict. PURE — a total
 * function over the recorded status string; it NEVER calls an LLM or reads any
 * ambient state. Mirrors the throw-on-unknown discipline of
 * `projectCompletionOrigin` (dispatch/handlers/completion-origin-projector via
 * work-item): an unrecognized status is a corrupt/foreign fact and fails loud
 * rather than defaulting.
 *
 * Mapping (documented):
 *   - `verified`     → `ok`    — the predicate was executed and held;
 *   - `asserted`     → `ok`    — an asserted-only kind (reasoning/subjective/
 *                                creative/opinion/prediction/normative/…) that
 *                                the registry admits WITHOUT refutation — it is
 *                                a recorded claim, not a failure, so `ok`;
 *   - `inconclusive` → `warn`  — evidence was neither confirmed nor refuted;
 *   - `refuted`      → `error` — the predicate was executed and FAILED.
 */
export function mapVerdict(status: string): Verdict {
  switch (status) {
    case "verified":
    case "asserted":
      return "ok";
    case "inconclusive":
      return "warn";
    case "refuted":
      return "error";
    default:
      throw new Error(`unknown verifier status: ${status}`);
  }
}

// ---------------------------------------------------------------------------
// loop_key — deterministic per-iteration correlation key
// ---------------------------------------------------------------------------

/**
 * `loop_key` correlates the iterations of ONE retry/re-plan loop over the same
 * WorkItem. It is a PURE function of recorded facts: the canonical digest of
 * `(work_item_id, content_fingerprint.digest)`. Two attempts of the same
 * WorkItem whose content fingerprint digest is IDENTICAL (same task input,
 * handler, model, upstream, dependency-lock — a bare retry over identical work
 * content) share a loop_key; a different plan/content produces a different
 * content digest and therefore STARTS A NEW loop. `work_item_id` scopes the
 * key so identical content under different WorkItems never collides.
 */
export function deriveLoopKey(workItemId: string, contentDigest: string): string {
  return WorkItem.canonicalDigest({ workItemId, contentDigest });
}

// ---------------------------------------------------------------------------
// FlatEvent — the fixed 30-column projection row
// ---------------------------------------------------------------------------

const nonEmpty = z.string().min(1);
const nullableString = z.string().nullable();

/**
 * The flat-event row. EXACTLY 30 fields, in the order below (the JSONL column
 * order — do not reorder). `.strict()` rejects any extra column.
 */
export const FlatEvent = z
  .object({
    // -- identity (WorkItem owner stream + Attempt ledger facts) --
    owner_key: nonEmpty, // work-item owner stream id `work:<hash>`
    work_item_id: nonEmpty, // WorkItem.Info.hash
    attempt_id: nonEmpty, // Attempt.attemptId
    attempt_seq: z.number().int().positive(), // Attempt.attemptSeq
    retry_of: z.string().min(1).nullable(), // Attempt.retryOf
    reused_from_attempt_id: z.string().min(1).nullable(), // Attempt.reusedFromAttemptId
    // -- step position (transcript_fact) --
    step: z.number().int().nonnegative(), // transcript step ordinal
    parent_step: z.number().int().nonnegative().nullable(),
    agent: nullableString, // executing agent/session identity
    op: nonEmpty, // transcript fact / operation type
    thought: nullableString,
    action: nullableString,
    action_args: JsonValue.nullable(),
    observation_hash: nullableString, // I3 sidecar — carried through
    // -- model call telemetry (recorded, not bus) --
    model: nullableString,
    in_tokens: z.number().int().nonnegative().nullable(),
    out_tokens: z.number().int().nonnegative().nullable(),
    finish_reason: nullableString,
    // -- verification outcome --
    verdict: Verdict.nullable(), // mapVerdict(status) or null
    checked_predicate: nullableString, // VerificationResult.checkedPredicate
    error_type: nullableString,
    // -- loop / plan correlation --
    loop_key: nonEmpty, // deriveLoopKey(work_item_id, content digest)
    plan_divergence: nullableString,
    state_hash: nullableString,
    prompt_hash: nullableString, // I3 sidecar — carried through
    // -- attempt fingerprints (SCALAR digests) --
    content_fingerprint: nonEmpty, // Attempt.contentFingerprint.digest
    environment_fingerprint: nonEmpty, // Attempt.environmentFingerprint.digest
    // -- replay identity (I2 writers) — carried through --
    cache_key: nullableString,
    replay_key: nullableString,
    nondeterminism_manifest_hash: nullableString,
  })
  .strict();
export type FlatEvent = z.infer<typeof FlatEvent>;

/** The 30 field names, in order — exported so export/replay share one list. */
export const FLAT_EVENT_FIELDS = Object.keys(FlatEvent.shape) as (keyof FlatEvent)[];

// ---------------------------------------------------------------------------
// ProjectionInput — the assembled intermediate this fold consumes
// ---------------------------------------------------------------------------

/**
 * The immutable recorded-order key for one step. Because `ledger_event` has NO
 * global append-ordinal column (its PK is `(stream_id, seq)` only — migration
 * 0013), a total order is imposed by `(timeCreated ASC, streamId ASC, seq
 * ASC)` over RECORDED archive values. This is deterministic precisely because
 * every value is the value the row was PERSISTED with (the archive stores
 * recorded time, never a live clock): the same archived rows always sort the
 * same way, on any machine, at any time. `timeCreated`/`streamId`/`seq` come
 * straight off the immutable row — the fold NEVER reads `Date.now()`.
 */
const StepOrder = z
  .object({
    timeCreated: z.number().int(),
    streamId: z.string().min(1),
    seq: z.number().int().nonnegative(),
  })
  .strict();
type StepOrder = z.infer<typeof StepOrder>;

/**
 * One assembled per-step fact bundle. The assembler (later increments) reads
 * the attempt ledger + transcript facts and populates this; the fold below is
 * a pure map from it. The full `WorkItem.Attempt` identity rides along so the
 * fold — not the caller — owns extracting the SCALAR fingerprint digests and
 * deriving `loop_key`, keeping those decisions in one pure place.
 */
export const ProjectionStep = z
  .object({
    order: StepOrder,
    ownerKey: nonEmpty,
    workItemId: nonEmpty,
    attempt: WorkItem.Attempt,
    step: z.number().int().nonnegative(),
    parentStep: z.number().int().nonnegative().nullable(),
    agent: nullableString,
    op: nonEmpty,
    thought: nullableString,
    action: nullableString,
    actionArgs: JsonValue.nullable(),
    observationHash: nullableString,
    model: nullableString,
    inTokens: z.number().int().nonnegative().nullable(),
    outTokens: z.number().int().nonnegative().nullable(),
    finishReason: nullableString,
    /** Recorded verifier status; `null` for a non-verification step. */
    verifierStatus: VerifierStatus.nullable(),
    checkedPredicate: nullableString,
    errorType: nullableString,
    planDivergence: nullableString,
    stateHash: nullableString,
    promptHash: nullableString,
    cacheKey: nullableString,
    replayKey: nullableString,
    nondeterminismManifestHash: nullableString,
  })
  .strict();
export type ProjectionStep = z.infer<typeof ProjectionStep>;

/** The full assembled projection input: the per-step bundles to flatten. */
export const ProjectionInput = z.object({ steps: z.array(ProjectionStep) }).strict();
export type ProjectionInput = z.infer<typeof ProjectionInput>;

// ---------------------------------------------------------------------------
// foldToFlatEvents — the pure projection
// ---------------------------------------------------------------------------

function compareStepOrder(a: StepOrder, b: StepOrder): number {
  if (a.timeCreated !== b.timeCreated) return a.timeCreated - b.timeCreated;
  if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * Folds an assembled `ProjectionInput` into a deterministically ordered
 * `FlatEvent[]`. PURE: same input → byte-identical output every time, on any
 * machine. The fold — not the caller — imposes the global order (see
 * `StepOrder`) by sorting on the recorded key, so input list order is
 * irrelevant to the result. A non-total order (two bundles sharing the exact
 * `(timeCreated, streamId, seq)` tuple) is a corrupt assembly and fails loud
 * rather than producing an ambiguous projection.
 */
export function foldToFlatEvents(input: ProjectionInput): FlatEvent[] {
  const parsed = ProjectionInput.parse(input);
  const ordered = [...parsed.steps].sort((a, b) => compareStepOrder(a.order, b.order));

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareStepOrder(previous.order, current.order) === 0
    ) {
      throw new Error(
        `non-total projection order: duplicate (timeCreated,streamId,seq) at ${current.order.streamId}#${current.order.seq}`,
      );
    }
  }

  return ordered.map((bundle) => {
    const attempt = bundle.attempt;
    const row: FlatEvent = {
      owner_key: bundle.ownerKey,
      work_item_id: bundle.workItemId,
      attempt_id: attempt.attemptId,
      attempt_seq: attempt.attemptSeq,
      retry_of: attempt.retryOf,
      reused_from_attempt_id: attempt.reusedFromAttemptId,
      step: bundle.step,
      parent_step: bundle.parentStep,
      agent: bundle.agent,
      op: bundle.op,
      thought: bundle.thought,
      action: bundle.action,
      action_args: bundle.actionArgs,
      observation_hash: bundle.observationHash,
      model: bundle.model,
      in_tokens: bundle.inTokens,
      out_tokens: bundle.outTokens,
      finish_reason: bundle.finishReason,
      verdict: bundle.verifierStatus === null ? null : mapVerdict(bundle.verifierStatus),
      checked_predicate: bundle.checkedPredicate,
      error_type: bundle.errorType,
      loop_key: deriveLoopKey(bundle.workItemId, attempt.contentFingerprint.digest),
      plan_divergence: bundle.planDivergence,
      state_hash: bundle.stateHash,
      prompt_hash: bundle.promptHash,
      content_fingerprint: attempt.contentFingerprint.digest,
      environment_fingerprint: attempt.environmentFingerprint.digest,
      cache_key: bundle.cacheKey,
      replay_key: bundle.replayKey,
      nondeterminism_manifest_hash: bundle.nondeterminismManifestHash,
    };
    return FlatEvent.parse(row);
  });
}
