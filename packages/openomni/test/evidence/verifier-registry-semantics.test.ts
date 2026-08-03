/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { VerifierRegistry } from "../../src/evidence/verifier-registry";

function obligation(
  kind: VerifierRegistry.ObligationKind,
  recordedInputs: VerifierRegistry.JsonValue,
) {
  return {
    obligationId: `obligation:${kind}`,
    kind,
    claim: "recorded predicate",
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
      obligation("citation_support", {
        archivedText:
          `${"Background context about unrelated archival details. ".repeat(100)}` +
          "The measured value is exactly 42 units.",
        claimText: "The measured value is 42 units.",
      }),
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
      obligation("citation_support", { archivedText, claimText }),
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
      obligation("citation_support", {
        archivedText: "The archive discusses a different project and no measured values.",
        claimText: "The measured value is 42 units.",
      }),
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
      obligation("citation_support", {
        archivedText: "The system is currently safe for all users.",
        claimText: "The system is currently unsafe for all users.",
      }),
    );
    expect(fact).toMatchObject({
      type: "verification_result",
      status: "inconclusive",
      checkedPredicate: expect.any(String),
    });
  });
});
