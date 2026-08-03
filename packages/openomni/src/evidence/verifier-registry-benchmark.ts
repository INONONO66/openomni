import { Tool } from "@openomni/protocol";
import { hashCanonicalJson } from "./verifier-conformance-canonical.js";
import {
  type VerifierRegistryScenarioReceipt,
  VerifierRegistryDriverSurface,
  VerifierRegistryScenarioReceiptSchema,
} from "./verifier-registry-driver-contract.js";
import { VerifierRegistry } from "./verifier-registry.js";
import { verificationBasisHash } from "./verifier-registry-core.js";

type ExpectedStatus = "verified" | "refuted" | "asserted";
type Fixture = Readonly<{
  input: VerifierRegistry.Obligation;
  expected: ExpectedStatus;
}>;

export function measureVerifierRegistryBenchmark(
  receipts: readonly VerifierRegistryScenarioReceipt[],
) {
  const registry = VerifierRegistry.create();
  const fixtures = taxonomyFixtures();
  const observations = fixtures.map((fixture) => {
    const fact = registry.verify(fixture.input);
    return {
      expected: fixture.expected,
      actual: fact.type === "verification_result" ? fact.status : "verification_error",
      basisBound:
        fact.type === "verification_result" &&
        fact.basisHash ===
          verificationBasisHash(fixture.input, fact.verifierId, fact.modelFingerprint),
      predicateBound:
        fact.type === "verification_result" &&
        (fact.status === "asserted" || fact.checkedPredicate !== undefined),
    };
  });
  const assertedTruePositive = observations.filter(
    ({ actual, expected }) => actual === "asserted" && expected === "asserted",
  ).length;
  const assertedFalsePositive = observations.filter(
    ({ actual, expected }) => actual === "asserted" && expected !== "asserted",
  ).length;
  const assertedFalseNegative = observations.filter(
    ({ actual, expected }) => actual !== "asserted" && expected === "asserted",
  ).length;
  const correctCount = observations.filter(({ actual, expected }) => actual === expected).length;
  const decisive = observations.filter(({ actual }) => actual !== "asserted");
  const exposedCapabilities = VerifierRegistry.SandboxCapability.options.filter((capability) => {
    const fact = registry.verify(programRequest([capability], []));
    return (
      fact.type !== "verification_error" ||
      fact.code !== "prohibited_capability" ||
      fact.violation !== capability
    );
  });
  const exposedActions = VerifierRegistry.ForbiddenAction.options.filter((action) => {
    const fact = registry.verify(programRequest([], [action]));
    return (
      fact.type !== "verification_error" ||
      fact.code !== "forbidden_action" ||
      fact.violation !== action
    );
  });
  const nativeReceipt = receipts.find(({ scenario }) => scenario === "valid-native-round-trip");

  return {
    taxonomy: {
      familyCount: VerifierRegistry.ObligationKind.options.length,
      executableFamilyCount:
        VerifierRegistry.ObligationKind.options.length -
        VerifierRegistry.AssertedOnlyKind.options.length,
      assertedFamilyCount: VerifierRegistry.AssertedOnlyKind.options.length,
      fixtureCount: fixtures.length,
      assertedRate:
        VerifierRegistry.AssertedOnlyKind.options.length /
        VerifierRegistry.ObligationKind.options.length,
      assertedTruePositive,
      assertedFalsePositive,
      assertedFalseNegative,
      assertedPrecision: ratio(assertedTruePositive, assertedTruePositive + assertedFalsePositive),
      assertedRecall: ratio(assertedTruePositive, assertedTruePositive + assertedFalseNegative),
    },
    accuracy: {
      fixtureCount: fixtures.length,
      correctCount,
      rate: correctCount / fixtures.length,
    },
    trust: {
      decisiveCount: decisive.length,
      basisBoundCount: decisive.filter(({ basisBound }) => basisBound).length,
      predicateBoundCount: decisive.filter(({ predicateBound }) => predicateBound).length,
    },
    toolValidity: {
      astValid:
        nativeReceipt?.observation.nativeCall !== undefined &&
        Tool.Call.safeParse(nativeReceipt.observation.nativeCall).success,
      schemaValid: receipts.every(
        (receipt) => VerifierRegistryScenarioReceiptSchema.safeParse(receipt).success,
      ),
      nativeRoundTripValid:
        nativeReceipt?.ok === true && nativeReceipt.observation.roundTripEqual === true,
    },
    surface: {
      toolCount: VerifierRegistryDriverSurface.toolNames.length,
      fieldCount: VerifierRegistryDriverSurface.fieldNames.length,
      tokenCount: VerifierRegistryDriverSurface.tokens.length,
    },
    exposedActions,
    exposedCapabilities,
  };
}

function taxonomyFixtures(): readonly Fixture[] {
  const digest = hashCanonicalJson("hello");
  const executable: readonly [
    VerifierRegistry.ObligationKind,
    unknown,
    unknown,
    string?,
    string?,
  ][] = [
    [
      "schema_validity",
      { schema: "native_tool_call", value: { id: "call", tool: "read", input: {} } },
      { schema: "native_tool_call", value: { id: 1, tool: "read", input: {} } },
    ],
    [
      "numeric_recheck",
      { operator: "eq", left: 1, right: 1 },
      { operator: "lt", left: 2, right: 1 },
    ],
    [
      "code_recheck",
      { operation: "add", operands: [1, 2], expected: 3 },
      { operation: "add", operands: [1, 2], expected: 4 },
    ],
    [
      "archived_url_recheck",
      { target: "https://archive.test", observedStatus: 200, expectedStatus: 200 },
      { target: "https://archive.test", observedStatus: 404, expectedStatus: 200 },
    ],
    [
      "archived_api_recheck",
      {
        target: "https://archive.test/api",
        method: "GET",
        observedStatus: 200,
        expectedStatus: 200,
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
      { algorithm: "sha256", value: "hello", expectedDigest: digest },
      { algorithm: "sha256", value: "goodbye", expectedDigest: digest },
    ],
    [
      "archived_quote_match",
      { archivedText: "A quoted passage.", quotedText: "quoted passage" },
      { archivedText: "A quoted passage.", quotedText: "invented passage" },
    ],
    [
      "citation_support",
      { archivedText: "The value is 42 units." },
      { archivedText: "The value is 99 units." },
      "The value is 42 units.",
      "The value is 42 units.",
    ],
  ];
  const fixtures: Fixture[] = [];
  for (const [kind, good, bad, goodClaim, badClaim] of executable) {
    fixtures.push(
      { input: obligation(kind, good, goodClaim), expected: "verified" },
      { input: obligation(kind, bad, badClaim), expected: "refuted" },
    );
  }
  for (const kind of VerifierRegistry.AssertedOnlyKind.options) {
    fixtures.push({ input: obligation(kind, {}), expected: "asserted" });
  }
  return fixtures;
}

function obligation(
  kind: VerifierRegistry.ObligationKind,
  recordedInputs: unknown,
  claim = "labeled benchmark fixture",
): VerifierRegistry.Obligation {
  return VerifierRegistry.Obligation.parse({
    obligationId: `benchmark:${kind}`,
    kind,
    claim,
    recordedInputs,
  });
}

function programRequest(
  capabilities: readonly VerifierRegistry.SandboxCapability[],
  actions: readonly VerifierRegistry.ForbiddenAction[],
) {
  return {
    obligation: obligation("numeric_recheck", { operator: "eq", left: 1, right: 1 }),
    program: {
      version: "verifier-program-v1",
      outputVersion: "verification-fact-v1",
      capabilities,
      actions,
    },
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}
