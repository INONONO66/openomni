import { describe, expect, test } from "bun:test";
import { WorkItem } from "../../src/index.js";

function contentInputs(): Parameters<typeof WorkItem.contentFingerprintOf>[0] {
  return {
    workInput: "prove attempt identity semantics",
    handlerKind: "internal_chat_agent",
    handlerCodeRef: { absent: true, reason: "handler code identity is not captured in this test" },
    model: {
      provider: "anthropic",
      id: "claude-test",
      parameters: { absent: true, reason: "no model parameters are configured" },
    },
    upstreamFingerprints: {
      absent: true,
      reason: "no upstream attempts are consumed in this test",
    },
    dependencyLock: { absent: true, reason: "dependency lock is not read in this test" },
  };
}

function environmentInputs(): Parameters<typeof WorkItem.environmentFingerprintOf>[0] {
  return {
    os: "darwin",
    arch: "arm64",
    bunVersion: "1.2.0",
    workspaceRoot: "/workspace/test",
    schemaVersions: { policyKernel: 1 },
    policy: { labels: ["default"] },
    toolVersions: { absent: true, reason: "tool versions are not enumerated" },
    verifierVersions: { absent: true, reason: "verifier versions are not enumerated" },
    providerParameters: { absent: true, reason: "no provider parameters are configured" },
    configRef: { absent: true, reason: "no redacted config identity exists" },
  };
}

function attemptOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: "attempt_alpha",
    attemptSeq: 1,
    retryOf: null,
    contentFingerprint: WorkItem.contentFingerprintOf(contentInputs()),
    environmentFingerprint: WorkItem.environmentFingerprintOf(environmentInputs()),
    reusedFromAttemptId: null,
    ...overrides,
  };
}

/** Tamper helper: always yields a DIFFERENT last character ("0" is a valid hex/last char, so a blind replace can be a no-op). */
function forgeLastChar(value: string): string {
  return value.replace(/.$/, (last) => (last === "0" ? "1" : "0"));
}

function refineMessages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  if (result.success || !result.error) throw new Error("expected a refine rejection");
  return result.error.issues.map((issue) => issue.message);
}

describe("WorkItem.canonicalDigest", () => {
  test("is key-order independent and value sensitive", () => {
    const digest = WorkItem.canonicalDigest({ b: [1, 2], a: "x" });
    expect(digest).toBe(WorkItem.canonicalDigest({ a: "x", b: [1, 2] }));
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(WorkItem.canonicalDigest({ a: "x", b: [2, 1] })).not.toBe(digest);
  });

  test("fails loudly on non-JSON values instead of silently coercing", () => {
    expect(() => WorkItem.canonicalDigest({ at: new Date(0) })).toThrow("plain objects only");
    expect(() => WorkItem.canonicalDigest({ n: Number.POSITIVE_INFINITY })).toThrow(
      "finite numbers only",
    );
    expect(() => WorkItem.canonicalDigest({ gap: undefined })).toThrow("undefined at gap");
  });
});

describe("WorkItem fingerprints", () => {
  test("constructor digest and schema refine agree; a tampered digest rejects", () => {
    const fingerprint = WorkItem.contentFingerprintOf(contentInputs());
    expect(fingerprint.digest).toBe(WorkItem.canonicalDigest(fingerprint.inputs));
    expect(WorkItem.ContentFingerprint.safeParse(fingerprint).success).toBe(true);

    const forged = { ...fingerprint, digest: forgeLastChar(fingerprint.digest) };
    const rejected = WorkItem.ContentFingerprint.safeParse(forged);
    expect(refineMessages(rejected)).toContain(
      "fingerprint digest does not match its canonical inputs",
    );
  });

  test("identical materials repeat the digest; different work input changes it", () => {
    const first = WorkItem.contentFingerprintOf(contentInputs());
    const second = WorkItem.contentFingerprintOf(contentInputs());
    expect(second.digest).toBe(first.digest);
    const changed = WorkItem.contentFingerprintOf({
      ...contentInputs(),
      workInput: "a different delegated goal",
    });
    expect(changed.digest).not.toBe(first.digest);
  });

  test("a declared coverage slot cannot be silently omitted — absent-but-listed only", () => {
    const { dependencyLock: _dropped, ...withoutLock } = contentInputs();
    expect(WorkItem.ContentFingerprintInputs.safeParse(withoutLock).success).toBe(false);
    const unlisted = WorkItem.ContentFingerprintInputs.safeParse({
      ...contentInputs(),
      dependencyLock: { absent: true },
    });
    expect(unlisted.success).toBe(false);
  });

  test("environment config identity accepts only non-reversible references", () => {
    const leaked = WorkItem.EnvironmentFingerprintInputs.safeParse({
      ...environmentInputs(),
      configRef: "sk-live-raw-secret-value",
    });
    expect(leaked.success).toBe(false);
    const referenced = WorkItem.EnvironmentFingerprintInputs.safeParse({
      ...environmentInputs(),
      configRef: "version:config/openomni@42",
    });
    expect(referenced.success).toBe(true);
  });
});

describe("WorkItem.Attempt", () => {
  test("accepts a first attempt with null lineage and null reuse", () => {
    const attempt = WorkItem.Attempt.parse(attemptOf());
    expect(attempt.attemptSeq).toBe(1);
    expect(attempt.retryOf).toBeNull();
    expect(attempt.reusedFromAttemptId).toBeNull();
  });

  test("the first attempt of a WorkItem cannot carry retry lineage", () => {
    const rejected = WorkItem.Attempt.safeParse(attemptOf({ retryOf: "attempt_zero" }));
    expect(refineMessages(rejected)).toContain(
      "the first attempt of a WorkItem has no prior lineage",
    );
  });

  test("retryOf is lineage, never self-reference", () => {
    const rejected = WorkItem.Attempt.safeParse(
      attemptOf({ attemptSeq: 2, retryOf: "attempt_alpha" }),
    );
    expect(refineMessages(rejected)).toContain(
      "retryOf is prior-attempt lineage — an attempt cannot retry itself",
    );
  });

  test("a cache hit records the prior attempt, never itself", () => {
    const rejected = WorkItem.Attempt.safeParse(
      attemptOf({ reusedFromAttemptId: "attempt_alpha" }),
    );
    expect(refineMessages(rejected)).toContain(
      "a cache hit records the prior attempt — an attempt cannot reuse itself",
    );
  });

  test("attemptSeq is a positive integer — zero and fractions reject", () => {
    expect(WorkItem.Attempt.safeParse(attemptOf({ attemptSeq: 0 })).success).toBe(false);
    expect(WorkItem.Attempt.safeParse(attemptOf({ attemptSeq: 1.5 })).success).toBe(false);
  });

  test("generateAttemptId mints distinct opaque ids", () => {
    const first = WorkItem.generateAttemptId();
    const second = WorkItem.generateAttemptId();
    expect(first).not.toBe(second);
    expect(WorkItem.AttemptId.safeParse(first).success).toBe(true);
  });
});
