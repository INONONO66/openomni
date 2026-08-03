/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { VerifierRegistry } from "../../src/evidence/verifier-registry";

function obligation(
  kind: VerifierRegistry.ObligationKind,
  recordedInputs: VerifierRegistry.JsonValue,
  claim = "recorded predicate",
) {
  return {
    obligationId: `obligation:${kind}`,
    kind,
    claim,
    recordedInputs,
  };
}

describe("verifier registry scoped result semantics", () => {
  test("returns inconclusive when an expected archive digest was not observed", () => {
    const fact = VerifierRegistry.create().verify(
      obligation("archived_url_recheck", {
        target: "https://archive.test/page",
        observedStatus: 200,
        expectedStatus: 200,
        expectedDigest: `sha256:${"a".repeat(64)}`,
      }),
    );
    expect(fact).toMatchObject({
      type: "verification_result",
      status: "inconclusive",
      checkedPredicate: expect.stringContaining("digest"),
    });
  });

  test("supports a cited claim inside substantial archived context", () => {
    const fact = VerifierRegistry.create().verify(
      obligation(
        "citation_support",
        {
          archivedText:
            `${"Background context about unrelated archival details. ".repeat(100)}` +
            "The measured value is exactly 42 units.",
        },
        "The measured value is 42 units.",
      ),
    );
    expect(fact).toMatchObject({
      type: "verification_result",
      status: "verified",
      checkedPredicate: expect.any(String),
      modelFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  test.each([
    ["Alice won the election.", "Alice lost the election."],
    ["The server accepted the request.", "The server rejected the request."],
    ["Sales increased by 10 percent.", "Sales decreased by 10 percent."],
  ])("refutes contradictory citation wording: %s / %s", (archivedText, claimText) => {
    const fact = VerifierRegistry.create().verify(
      obligation("citation_support", { archivedText }, claimText),
    );
    expect(fact).toMatchObject({
      type: "verification_result",
      status: "refuted",
      checkedPredicate: expect.any(String),
      modelFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  test("uses inconclusive rather than refuted for insufficient citation evidence", () => {
    const fact = VerifierRegistry.create().verify(
      obligation(
        "citation_support",
        {
          archivedText: "The archive discusses a different project and no measured values.",
        },
        "The measured value is 42 units.",
      ),
    );
    expect(fact).toMatchObject({
      type: "verification_result",
      status: "inconclusive",
      checkedPredicate: expect.any(String),
      modelFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  test("refutes a frozen one-token opposition pair", () => {
    const fact = VerifierRegistry.create().verify(
      obligation(
        "citation_support",
        {
          archivedText: "The system is currently safe for all users.",
        },
        "The system is currently unsafe for all users.",
      ),
    );
    expect(fact).toMatchObject({
      type: "verification_result",
      status: "refuted",
      checkedPredicate: expect.any(String),
    });
  });

  test.each([
    ["The team lost the election.", "Alice won the election.", "inconclusive"],
    ["The measured value exists.", "The measured value is 42 units.", "inconclusive"],
    ["The measured value is 42 units.", "42", "inconclusive"],
    ["The dog bit the man.", "The man bit the dog.", "inconclusive"],
    [
      "This unrelated warning is not relevant. The release passed all checks.",
      "The release passed all checks.",
      "verified",
    ],
    [
      "No incidents occurred and the measured value is exactly 42 units.",
      "The measured value is 42 units.",
      "inconclusive",
    ],
    [
      "The release did not regress and passed all checks.",
      "The release passed all checks.",
      "inconclusive",
    ],
    ["The measured value is not 42 units.", "The measured value is 42 units.", "refuted"],
    ["The measured value is not 42 units.", "The measured value is 99 units.", "inconclusive"],
    ["The measured value is not 42 units.", "The measured value is not 99 units.", "inconclusive"],
    [
      "The release passed all checks; or the release failed all checks.",
      "The release passed all checks.",
      "inconclusive",
    ],
    [
      "The release passed all checks; or the release failed all checks.",
      "The release failed all checks.",
      "inconclusive",
    ],
    [
      "The release passed all checks; the release failed all checks.",
      "The release passed all checks.",
      "inconclusive",
    ],
    [
      "The release passed all checks. The release failed all checks.",
      "The release passed all checks.",
      "inconclusive",
    ],
    [
      "Alice entered the election. Carol won the election.",
      "Alice won the election.",
      "inconclusive",
    ],
    [
      "Alice entered the election and Carol won the election.",
      "Alice won the election.",
      "inconclusive",
    ],
    [
      "Alice passed all checks, but Bob failed all checks.",
      "Alice passed all checks.",
      "inconclusive",
    ],
    ["The release did not fail all checks.", "The release passed all checks.", "inconclusive"],
    ["The release did not not pass checks.", "The release did not pass checks.", "refuted"],
    ["The system is safe. The system is unsafe.", "The system is safe.", "inconclusive"],
    ["Alice scored 5 and Bob scored 10.", "Alice scored 10.", "inconclusive"],
    ["Alice told Bob that Carol won the election.", "Bob won the election.", "inconclusive"],
    ["Alice did not say that Bob won the election.", "Bob won the election.", "inconclusive"],
    ["Neither Alice nor Bob won.", "Alice won.", "inconclusive"],
    ["Neither Alice nor Bob won.", "Bob won.", "inconclusive"],
    ["Alice or Bob won.", "Bob won.", "inconclusive"],
    ["It is false that the system is safe.", "The system is safe.", "inconclusive"],
    ["According to Bob, Alice won the election.", "Alice won the election.", "inconclusive"],
    ["According to a report,\nBob won the election.", "Bob won the election.", "inconclusive"],
    ["Maybe, Bob won the election.", "Bob won the election.", "inconclusive"],
    ["The system is safe or unsafe.", "The system is safe.", "inconclusive"],
    ["The report denies that the value is 42 units.", "The value is 42 units.", "inconclusive"],
    ["We failed to show that the value is 42 units.", "The value is 42 units.", "inconclusive"],
  ])("evaluates citation propositions locally: %s / %s", (archivedText, claim, status) => {
    const fact = VerifierRegistry.create().verify(
      obligation("citation_support", { archivedText }, claim),
    );
    expect(fact).toMatchObject({ type: "verification_result", status });
  });

  test("returns inconclusive when archived sentence count exceeds the frozen ceiling", () => {
    const fact = VerifierRegistry.create().verify(
      obligation(
        "citation_support",
        { archivedText: `${"Noise. ".repeat(4097)}The measured value is 42 units.` },
        "The measured value is 42 units.",
      ),
    );
    expect(fact).toMatchObject({ type: "verification_result", status: "inconclusive" });
  });

  test("handles a maximal whitespace run without regex amplification", () => {
    const fact = VerifierRegistry.create().verify(
      obligation(
        "citation_support",
        { archivedText: " ".repeat(65_536) },
        "The measured value is 42 units.",
      ),
    );
    expect(fact).toMatchObject({ type: "verification_result", status: "inconclusive" });
  });

  test("handles maximal reversed numeric evidence within the bounded test timeout", () => {
    const ascending = Array.from({ length: 10_000 }, (_, index) => String(index));
    const fact = VerifierRegistry.create().verify(
      obligation(
        "citation_support",
        { archivedText: `x ${[...ascending].reverse().join(" ")}` },
        `x ${ascending.join(" ")}`,
      ),
    );
    expect(fact).toMatchObject({ type: "verification_result", status: "inconclusive" });
  });

  test("rejects a second caller-controlled citation claim", () => {
    const fact = VerifierRegistry.create().verify(
      obligation(
        "citation_support",
        {
          archivedText: "The sky is blue.",
          claimText: "The sky is blue.",
        },
        "Alice won the election.",
      ),
    );
    expect(fact).toMatchObject({ type: "verification_error", code: "malformed_input" });
  });
});
