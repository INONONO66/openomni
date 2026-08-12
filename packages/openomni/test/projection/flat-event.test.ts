import { describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import {
  deriveLoopKey,
  FLAT_EVENT_FIELDS,
  FlatEvent,
  foldToFlatEvents,
  mapVerdict,
  type ProjectionInput,
  type ProjectionStep,
} from "@openomni/openomni/projection";

// ---------------------------------------------------------------------------
// fixture builders — every field is supplied so the schema + mapping + order
// + verdict are fully proven now (later-increment writers do not exist yet).
// ---------------------------------------------------------------------------

function contentFingerprint(workInput: string): WorkItem.ContentFingerprint {
  return WorkItem.contentFingerprintOf({
    workInput,
    handlerKind: "worker",
    handlerCodeRef: { absent: true, reason: "test fixture" },
    model: {
      provider: "anthropic",
      id: "claude-fable-5",
      parameters: { absent: true, reason: "test fixture" },
    },
    upstreamFingerprints: { absent: true, reason: "test fixture" },
    dependencyLock: { absent: true, reason: "test fixture" },
  });
}

function environmentFingerprint(): WorkItem.EnvironmentFingerprint {
  return WorkItem.environmentFingerprintOf({
    os: "darwin",
    arch: "arm64",
    bunVersion: "1.2.0",
    workspaceRoot: { absent: true, reason: "test fixture" },
    schemaVersions: { protocol: 1 },
    policy: { absent: true, reason: "test fixture" },
    toolVersions: { absent: true, reason: "test fixture" },
    verifierVersions: { absent: true, reason: "test fixture" },
    providerParameters: { absent: true, reason: "test fixture" },
    configRef: { absent: true, reason: "test fixture" },
  });
}

function attempt(
  overrides: Partial<WorkItem.Attempt> & { workInput?: string } = {},
): WorkItem.Attempt {
  const { workInput, ...rest } = overrides;
  return WorkItem.Attempt.parse({
    attemptId: "attempt_a",
    attemptSeq: 1,
    retryOf: null,
    reusedFromAttemptId: null,
    contentFingerprint: contentFingerprint(workInput ?? "ship the widget"),
    environmentFingerprint: environmentFingerprint(),
    ...rest,
  });
}

function step(overrides: Partial<ProjectionStep> = {}): ProjectionStep {
  return {
    order: { timeCreated: 1_000, streamId: "work:abc", seq: 1 },
    ownerKey: "work:abc",
    workItemId: "abc",
    attempt: attempt(),
    step: 0,
    parentStep: null,
    agent: "session-1",
    op: "part.advanced",
    thought: "let me try",
    action: "bash",
    actionArgs: { cmd: "ls" },
    observationHash: "sha256:obs",
    model: "claude-fable-5",
    inTokens: 10,
    outTokens: 20,
    finishReason: "stop",
    verifierStatus: "verified",
    checkedPredicate: "output === expected",
    errorType: null,
    planDivergence: null,
    stateHash: "sha256:state",
    promptHash: "sha256:prompt",
    cacheKey: "sha256:cache",
    replayKey: "sha256:replay",
    nondeterminismManifestHash: "sha256:manifest",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// schema shape — exactly 30 fields, in order
// ---------------------------------------------------------------------------

const EXPECTED_FIELDS = [
  "owner_key",
  "work_item_id",
  "attempt_id",
  "attempt_seq",
  "retry_of",
  "reused_from_attempt_id",
  "step",
  "parent_step",
  "agent",
  "op",
  "thought",
  "action",
  "action_args",
  "observation_hash",
  "model",
  "in_tokens",
  "out_tokens",
  "finish_reason",
  "verdict",
  "checked_predicate",
  "error_type",
  "loop_key",
  "plan_divergence",
  "state_hash",
  "prompt_hash",
  "content_fingerprint",
  "environment_fingerprint",
  "cache_key",
  "replay_key",
  "nondeterminism_manifest_hash",
] as const;

describe("FlatEvent schema", () => {
  test("has exactly the 30 fields in the mandated order", () => {
    expect(FLAT_EVENT_FIELDS).toEqual([...EXPECTED_FIELDS]);
    expect(FLAT_EVENT_FIELDS).toHaveLength(30);
  });

  test("a folded row carries all 30 fields and round-trips the schema", () => {
    const [row] = foldToFlatEvents({ steps: [step()] });
    expect(row).toBeDefined();
    expect(Object.keys(row as FlatEvent)).toEqual([...EXPECTED_FIELDS]);
    expect(() => FlatEvent.parse(row)).not.toThrow();
  });

  test("rejects an unknown column (strict)", () => {
    const [row] = foldToFlatEvents({ steps: [step()] });
    expect(() => FlatEvent.parse({ ...(row as FlatEvent), extra: true })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// verdict mapping — exhaustive incl. throw-on-unknown
// ---------------------------------------------------------------------------

describe("mapVerdict", () => {
  test("maps the full verifier status vocabulary", () => {
    expect(mapVerdict("verified")).toBe("ok");
    expect(mapVerdict("asserted")).toBe("ok");
    expect(mapVerdict("inconclusive")).toBe("warn");
    expect(mapVerdict("refuted")).toBe("error");
  });

  test("throws on an unknown status (fail loud)", () => {
    expect(() => mapVerdict("bogus")).toThrow("unknown verifier status: bogus");
    expect(() => mapVerdict("")).toThrow();
  });

  test("a null verifier status projects a null verdict", () => {
    const [row] = foldToFlatEvents({ steps: [step({ verifierStatus: null })] });
    expect(row?.verdict).toBeNull();
  });

  test("verifier statuses flow through the fold", () => {
    for (const [status, verdict] of [
      ["verified", "ok"],
      ["asserted", "ok"],
      ["inconclusive", "warn"],
      ["refuted", "error"],
    ] as const) {
      const [row] = foldToFlatEvents({ steps: [step({ verifierStatus: status })] });
      expect(row?.verdict).toBe(verdict);
    }
  });
});

// ---------------------------------------------------------------------------
// field provenance — scalar fingerprints, carried-through inputs
// ---------------------------------------------------------------------------

describe("field provenance", () => {
  test("fingerprints are the SCALAR .digest strings", () => {
    const a = attempt();
    const [row] = foldToFlatEvents({ steps: [step({ attempt: a })] });
    expect(row?.content_fingerprint).toBe(a.contentFingerprint.digest);
    expect(row?.environment_fingerprint).toBe(a.environmentFingerprint.digest);
    // NOT the structured object.
    expect(typeof row?.content_fingerprint).toBe("string");
    expect(row?.content_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("attempt identity maps from the Attempt ledger fact", () => {
    const a = attempt({
      attemptId: "attempt_b",
      attemptSeq: 2,
      retryOf: "attempt_a",
      reusedFromAttemptId: "attempt_a",
    });
    const [row] = foldToFlatEvents({ steps: [step({ attempt: a })] });
    expect(row?.attempt_id).toBe("attempt_b");
    expect(row?.attempt_seq).toBe(2);
    expect(row?.retry_of).toBe("attempt_a");
    expect(row?.reused_from_attempt_id).toBe("attempt_a");
  });

  test("the 5 later-increment fields are carried through, not invented", () => {
    const [carried] = foldToFlatEvents({ steps: [step()] });
    expect(carried?.prompt_hash).toBe("sha256:prompt");
    expect(carried?.observation_hash).toBe("sha256:obs");
    expect(carried?.cache_key).toBe("sha256:cache");
    expect(carried?.replay_key).toBe("sha256:replay");
    expect(carried?.nondeterminism_manifest_hash).toBe("sha256:manifest");

    const [absent] = foldToFlatEvents({
      steps: [
        step({
          promptHash: null,
          observationHash: null,
          cacheKey: null,
          replayKey: null,
          nondeterminismManifestHash: null,
        }),
      ],
    });
    expect(absent?.prompt_hash).toBeNull();
    expect(absent?.observation_hash).toBeNull();
    expect(absent?.cache_key).toBeNull();
    expect(absent?.replay_key).toBeNull();
    expect(absent?.nondeterminism_manifest_hash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loop_key — deterministic, pure over recorded facts
// ---------------------------------------------------------------------------

describe("loop_key", () => {
  test("is the canonical digest of (work_item_id, content digest)", () => {
    const a = attempt();
    const [row] = foldToFlatEvents({ steps: [step({ attempt: a })] });
    expect(row?.loop_key).toBe(deriveLoopKey("abc", a.contentFingerprint.digest));
  });

  test("identical work content across attempts shares a loop_key", () => {
    const first = attempt({ attemptId: "attempt_a", attemptSeq: 1, workInput: "same task" });
    const retry = attempt({
      attemptId: "attempt_b",
      attemptSeq: 2,
      retryOf: "attempt_a",
      workInput: "same task",
    });
    const [a] = foldToFlatEvents({ steps: [step({ attempt: first })] });
    const [b] = foldToFlatEvents({ steps: [step({ attempt: retry })] });
    expect(a?.loop_key).toBe(b?.loop_key ?? "");
  });

  test("a different plan/content starts a new loop", () => {
    const first = attempt({ workInput: "plan A" });
    const replan = attempt({
      attemptId: "attempt_b",
      attemptSeq: 2,
      retryOf: "attempt_a",
      workInput: "plan B",
    });
    const [a] = foldToFlatEvents({ steps: [step({ attempt: first })] });
    const [b] = foldToFlatEvents({ steps: [step({ attempt: replan })] });
    expect(a?.loop_key).not.toBe(b?.loop_key);
  });

  test("different WorkItems never collide on identical content", () => {
    const shared = attempt({ workInput: "identical" });
    const [a] = foldToFlatEvents({ steps: [step({ workItemId: "wi-1", attempt: shared })] });
    const [b] = foldToFlatEvents({ steps: [step({ workItemId: "wi-2", attempt: shared })] });
    expect(a?.loop_key).not.toBe(b?.loop_key);
  });
});

// ---------------------------------------------------------------------------
// deterministic global order + byte-identical output
// ---------------------------------------------------------------------------

describe("foldToFlatEvents determinism", () => {
  const s1 = step({
    order: { timeCreated: 1_000, streamId: "work:abc", seq: 1 },
    step: 0,
    op: "attempt.started",
  });
  const s2 = step({
    order: { timeCreated: 1_000, streamId: "work:abc", seq: 2 },
    step: 1,
    op: "part.advanced",
  });
  const s3 = step({
    order: { timeCreated: 2_000, streamId: "work:abc", seq: 1 },
    step: 2,
    op: "attempt.finished",
  });
  // Same recorded time, different stream — tie-broken by streamId ASC.
  const s4 = step({
    order: { timeCreated: 1_000, streamId: "work:aaa", seq: 9 },
    step: 3,
    op: "part.advanced",
  });

  test("orders by (timeCreated ASC, streamId ASC, seq ASC) regardless of input order", () => {
    const shuffled: ProjectionInput = { steps: [s3, s1, s4, s2] };
    const rows = foldToFlatEvents(shuffled);
    expect(rows.map((r) => r.op)).toEqual([
      "part.advanced", // work:aaa @1000 seq9
      "attempt.started", // work:abc @1000 seq1
      "part.advanced", // work:abc @1000 seq2
      "attempt.finished", // work:abc @2000 seq1
    ]);
  });

  test("same input yields byte-identical FlatEvent[] twice", () => {
    const input: ProjectionInput = { steps: [s3, s1, s4, s2] };
    const first = JSON.stringify(foldToFlatEvents(input));
    const second = JSON.stringify(foldToFlatEvents(input));
    expect(first).toBe(second);
  });

  test("input list order does not change the output", () => {
    const a = JSON.stringify(foldToFlatEvents({ steps: [s1, s2, s3, s4] }));
    const b = JSON.stringify(foldToFlatEvents({ steps: [s4, s3, s2, s1] }));
    expect(a).toBe(b);
  });

  test("a non-total order (duplicate order tuple) fails loud", () => {
    const dup = step({ order: { timeCreated: 1_000, streamId: "work:abc", seq: 1 }, step: 7 });
    expect(() => foldToFlatEvents({ steps: [s1, dup] })).toThrow("non-total projection order");
  });

  test("an empty input folds to an empty projection", () => {
    expect(foldToFlatEvents({ steps: [] })).toEqual([]);
  });
});
