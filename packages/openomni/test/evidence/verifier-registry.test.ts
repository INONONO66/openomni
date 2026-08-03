import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { FrozenNliSourceDigest } from "../../src/evidence/verifier-frozen-nli-model";
import { VerifierRegistry } from "../../src/evidence/verifier-registry";

const obligation = (
  kind: VerifierRegistry.ObligationKind,
  recordedInputs: VerifierRegistry.JsonValue,
  claim = "recorded predicate",
) => ({
  obligationId: `obligation:${kind}`,
  kind,
  claim,
  recordedInputs,
});

const request = (
  input: ReturnType<typeof obligation>,
  capabilities: readonly VerifierRegistry.SandboxCapability[] = [],
  actions: readonly VerifierRegistry.ForbiddenAction[] = [],
  outputVersion = "verification-fact-v1",
) => ({
  obligation: input,
  program: { version: "verifier-program-v1", outputVersion, capabilities, actions },
});

describe("VerifierRegistry", () => {
  test("publishes the complete taxonomy and maps asserted-only kinds", () => {
    expect(VerifierRegistry.ObligationKind.options).toEqual([
      "schema_validity",
      "numeric_recheck",
      "code_recheck",
      "archived_url_recheck",
      "archived_api_recheck",
      "hash_recheck",
      "archived_quote_match",
      "citation_support",
      "reasoning",
      "subjective",
      "creative",
      "opinion",
      "prediction",
      "normative_ethical",
      "out_of_archive",
    ]);
    const registry = VerifierRegistry.create();
    for (const kind of VerifierRegistry.AssertedOnlyKind.options) {
      expect(registry.verify(obligation(kind, {}))).toMatchObject({
        type: "verification_result",
        obligationId: `obligation:${kind}`,
        kind,
        verifierId: "asserted-only",
        status: "asserted",
        basisHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
    }
  });

  test("default registry deterministically verifies and refutes every executable family", () => {
    const hash = `sha256:${createHash("sha256").update(JSON.stringify("hello")).digest("hex")}`;
    const cases: readonly [
      VerifierRegistry.ObligationKind,
      VerifierRegistry.JsonValue,
      VerifierRegistry.JsonValue,
    ][] = [
      [
        "schema_validity",
        {
          schema: "native_tool_call",
          value: { id: "call-1", tool: "read", input: { path: "a" } },
        },
        { schema: "native_tool_call", value: { id: 1, tool: "read", input: {} } },
      ],
      [
        "numeric_recheck",
        { operator: "eq", left: 4, right: 4 },
        { operator: "lt", left: 4, right: 2 },
      ],
      [
        "code_recheck",
        { operation: "multiply", operands: [6, 7], expected: 42 },
        { operation: "add", operands: [6, 7], expected: 42 },
      ],
      [
        "archived_url_recheck",
        {
          target: "https://archive.test/page",
          observedStatus: 200,
          expectedStatus: 200,
          observedDigest: hash,
          expectedDigest: hash,
        },
        {
          target: "https://archive.test/page",
          observedStatus: 404,
          expectedStatus: 200,
        },
      ],
      [
        "archived_api_recheck",
        {
          target: "https://archive.test/api",
          method: "GET",
          observedStatus: 200,
          expectedStatus: 200,
          observedDigest: hash,
          expectedDigest: hash,
        },
        {
          target: "https://archive.test/api",
          method: "GET",
          observedStatus: 500,
          expectedStatus: 200,
        },
      ],
      [
        "hash_recheck",
        { algorithm: "sha256", value: "hello", expectedDigest: hash },
        { algorithm: "sha256", value: "goodbye", expectedDigest: hash },
      ],
      [
        "archived_quote_match",
        {
          archivedText: "A stable quoted passage.",
          quotedText: "quoted passage",
        },
        {
          archivedText: "A stable quoted passage.",
          quotedText: "invented passage",
        },
      ],
    ];
    const registry = VerifierRegistry.create();
    for (const [kind, good, bad] of cases) {
      expect(registry.verify(obligation(kind, good))).toMatchObject({
        type: "verification_result",
        kind,
        status: "verified",
        checkedPredicate: expect.any(String),
      });
      expect(registry.verify(obligation(kind, bad))).toMatchObject({
        type: "verification_result",
        kind,
        status: "refuted",
        checkedPredicate: expect.any(String),
      });
    }
  });

  test("uses the shipped fingerprinted symbolic NLI model with lexical and numeric support", () => {
    const registry = VerifierRegistry.create();
    expect(VerifierRegistry.FrozenNliModelFingerprint).toBe(
      "sha256:0c3e933ba7837149370fdbbcbd352da73941f42cec9e0b4719a40047c2cc23d5",
    );
    const modelSource = readFileSync(
      new URL("../../src/evidence/verifier-frozen-nli-model.ts", import.meta.url),
      "utf8",
    );
    const normalizedSource = modelSource.replace(
      FrozenNliSourceDigest,
      "sha256:<normalized-source-digest>",
    );
    expect(`sha256:${createHash("sha256").update(normalizedSource).digest("hex")}`).toBe(
      FrozenNliSourceDigest,
    );
    const supported = obligation(
      "citation_support",
      { archivedText: "The measured value is exactly 42 units." },
      "The measured value is 42 units.",
    );
    const knownBad = obligation(
      "citation_support",
      { archivedText: "The measured value is exactly 99 units." },
      "The measured value is 42 units.",
    );
    expect(registry.verify(supported)).toMatchObject({
      status: "verified",
      checkedPredicate: expect.stringContaining("frozen symbolic NLI relation"),
      modelFingerprint: VerifierRegistry.FrozenNliModelFingerprint,
    });
    expect(registry.verify(knownBad)).toMatchObject({
      status: "refuted",
      checkedPredicate: expect.stringContaining("frozen symbolic NLI relation"),
      modelFingerprint: VerifierRegistry.FrozenNliModelFingerprint,
    });
    expect(registry.verify(supported)).toEqual(registry.verify(supported));
  });

  test("has no host callback extension point", () => {
    let invoked = 0;
    const registry = Reflect.apply(VerifierRegistry.create, undefined, [
      {
        verifiers: [
          {
            run: () => {
              invoked += 1;
              return { status: "verified" };
            },
          },
        ],
        frozenNli: {
          infer: () => {
            invoked += 1;
            return { relation: "entails" };
          },
        },
      },
    ]);
    expect(
      registry.verify(obligation("numeric_recheck", { operator: "eq", left: 1, right: 2 })),
    ).toMatchObject({ status: "refuted", verifierId: "builtin.numeric-v1" });
    expect(invoked).toBe(0);
  });

  test("returns typed malformed input and output-contract facts", () => {
    const registry = VerifierRegistry.create();
    expect(registry.verify({ kind: "numeric_recheck" })).toMatchObject({
      type: "verification_error",
      code: "malformed_input",
    });
    expect(
      registry.verify(
        request(
          obligation("numeric_recheck", { operator: "eq", left: 1, right: 1 }),
          [],
          [],
          "unknown-v0",
        ),
      ),
    ).toMatchObject({ type: "verification_error", code: "malformed_input" });
    expect(
      registry.verify(
        obligation("code_recheck", {
          operation: "divide",
          operands: [1, 0],
          expected: 0,
        }),
      ),
    ).toMatchObject({ type: "verification_error", code: "malformed_input" });
  });

  test("rejects all capability and live-action requests before evaluation", () => {
    const input = obligation("numeric_recheck", { operator: "eq", left: 1, right: 1 });
    const registry = VerifierRegistry.create();
    for (const capability of VerifierRegistry.SandboxCapability.options) {
      expect(registry.verify(request(input, [capability]))).toMatchObject({
        type: "verification_error",
        code: "prohibited_capability",
        violation: capability,
      });
    }
    expect(VerifierRegistry.ForbiddenAction.options).toEqual([
      "session_import",
      "persist",
      "admit",
      "complete",
      "fold",
      "effect",
      "replay",
    ]);
    for (const action of VerifierRegistry.ForbiddenAction.options) {
      expect(registry.verify(request(input, [], [action]))).toMatchObject({
        type: "verification_error",
        code: "forbidden_action",
        violation: action,
      });
    }
  });
});
