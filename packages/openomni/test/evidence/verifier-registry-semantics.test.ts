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

  test("does not verify unsupported one-token lexical substitutions", () => {
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
      status: "inconclusive",
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
      "verified",
    ],
    ["The measured value is not 42 units.", "The measured value is 42 units.", "refuted"],
    [
      "Alice entered the election. Carol won the election.",
      "Alice won the election.",
      "inconclusive",
    ],
  ])("evaluates citation propositions locally: %s / %s", (archivedText, claim, status) => {
    const fact = VerifierRegistry.create().verify(
      obligation("citation_support", { archivedText }, claim),
    );
    expect(fact).toMatchObject({ type: "verification_result", status });
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
