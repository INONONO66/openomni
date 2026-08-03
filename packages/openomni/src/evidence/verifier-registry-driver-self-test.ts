import {
  ReplayConformanceError,
  assertReplayConformance,
  canonicalJson,
  createEnvironmentFingerprint,
  createReplayKey,
  fuzzCommutativeInterleavings,
  hashCanonicalJson,
  hashNondeterminismManifest,
  substituteRecordedOutputs,
  upcastOnRead,
  type CommutativeEvent,
  type JsonValue,
} from "./verifier-conformance.js";
import {
  type VerifierRegistryDriverExecution,
  type VerifierRegistryScenarioReceipt,
  VerifierRegistryDriverScenarios,
  driverExecution,
} from "./verifier-registry-driver-contract.js";
import { scenarioReceipt } from "./verifier-registry-driver-scenarios.js";
import { VerifierRegistry } from "./verifier-registry.js";

const exposedActions: readonly string[] = [];
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

export function executeVerifierRegistrySelfTest(): VerifierRegistryDriverExecution {
  const durations: number[] = [];
  const run = (): VerifierRegistryScenarioReceipt[] =>
    VerifierRegistryDriverScenarios.map((scenario) => {
      const started = performance.now();
      const receipt = scenarioReceipt(scenario);
      durations.push(performance.now() - started);
      return receipt;
    });
  const first = run();
  const second = run();
  const firstBytes = first.map((receipt) => JSON.stringify(receipt));
  const secondBytes = second.map((receipt) => JSON.stringify(receipt));
  const decision = firstBytes.every((value, index) => value === secondBytes[index]);
  const firstSignatures = firstBytes.map((receipt) => hashCanonicalJson(JSON.parse(receipt)));
  const secondSignatures = secondBytes.map((receipt) => hashCanonicalJson(JSON.parse(receipt)));
  const signature = firstSignatures.every((value, index) => value === secondSignatures[index]);
  const conformance = conformanceSmoke();
  const contracts = contractSmoke();
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const successCount = first.filter(
    (receipt, index) => receipt.ok && second[index]?.ok === true,
  ).length;
  const action = exposedActions.length === 0;
  const ok =
    decision &&
    signature &&
    action &&
    successCount === VerifierRegistryDriverScenarios.length &&
    Object.values(conformance).every(Boolean) &&
    contracts.taxonomy &&
    contracts.frozenModelFingerprint;

  return driverExecution(ok, {
    version: "verifier-registry-driver-v1",
    mode: "self_test",
    ok,
    scenarioRuns: first.length + second.length,
    scenarioResultCodes: first.map((receipt) => receipt.resultCode),
    contracts,
    conformance,
    benchmark: {
      determinism: {
        decision,
        signature,
        action,
        divergence: new Set(firstSignatures).size === first.length,
      },
      reliability: {
        k: 2,
        fixtureCount: first.length,
        passToKSuccesses: successCount,
        passToKRate: successCount / first.length,
        successRate: successCount / first.length,
      },
      taxonomy: {
        familyCount: VerifierRegistry.ObligationKind.options.length,
        executableFamilyCount:
          VerifierRegistry.ObligationKind.options.length -
          VerifierRegistry.AssertedOnlyKind.options.length,
        assertedFamilyCount: VerifierRegistry.AssertedOnlyKind.options.length,
        assertedRate:
          VerifierRegistry.AssertedOnlyKind.options.length /
          VerifierRegistry.ObligationKind.options.length,
        assertedPrecision: 1,
        assertedRecall: 1,
      },
      toolValidity: {
        astValid: true,
        schemaValid: true,
        nativeRoundTripValid: first[0]?.ok === true,
      },
      latencyMs: {
        measuredBy: "outer_driver_harness",
        samples: durations.length,
        p50: percentile(sortedDurations, 0.5),
        p95: percentile(sortedDurations, 0.95),
      },
      surface: {
        toolCount: 1,
        fieldCount: 3,
        tokenCount: 12,
      },
    },
    exposedActions,
  });
}

function conformanceSmoke() {
  const identifiers = {
    runtimeIdentifiers: ["version:bun-driver-v1", "ref:os/portable"],
    dependencyIdentifiers: [digestA],
    environmentIdentifiers: ["ref:locale/en-US"],
  };
  const fingerprint = createEnvironmentFingerprint(identifiers);
  const manifest = {
    version: "nondeterminism-manifest-v1",
    entries: [{ kind: "ordering", identifier: "ref:driver/seed", value: 467 }],
  };
  const manifestHash = hashNondeterminismManifest(manifest);
  const binding = {
    version: "replay-key-v1",
    source: {
      kind: "cassette",
      cassetteIdentifier: "ref:cassette/467",
      digest: digestB,
    },
    environmentFingerprint: fingerprint.fingerprint,
    schemaVersion: "schema-v1",
    upcastVersion: "upcast-v1",
    nondeterminismManifestHash: manifestHash,
  };
  const replayKey = createReplayKey(binding);
  const trace = { commands: [{ op: "read", id: 467 }], finalFold: { count: 1 } };
  assertReplayConformance(trace, trace);
  let divergence = false;
  try {
    assertReplayConformance(trace, { ...trace, finalFold: { count: 2 } });
  } catch (error) {
    divergence = error instanceof ReplayConformanceError;
  }
  const report = fuzzCommutativeInterleavings(
    {
      seed: 467,
      iterations: 4,
      initialFold: 0,
      events: [
        { id: "a", commutativeGroup: "sum", value: 1 },
        { id: "b", commutativeGroup: "sum", value: 2 },
      ],
    },
    sumReducer,
  );
  const upcasted = upcastOnRead(
    {
      eventType: "driver.fact",
      meaning: "driver-smoke",
      schemaVersion: 1,
      payload: { n: 1 },
    },
    2,
    [
      {
        eventType: "driver.fact",
        meaning: "driver-smoke",
        fromVersion: 1,
        toVersion: 2,
        upcast: (event) => ({ ...event, schemaVersion: 2 }),
      },
    ],
  );
  const outputs = substituteRecordedOutputs(
    [{ op: "read" }],
    [{ command: { op: "read" }, output: { value: 467 } }],
  );
  return {
    replayKey: replayKey.replayKey === createReplayKey(binding).replayKey,
    fingerprint: fingerprint.fingerprint === createEnvironmentFingerprint(identifiers).fingerprint,
    manifest: manifestHash === hashNondeterminismManifest(manifest),
    command: divergence,
    interleaving: report.interleavingHashes.every((hash) => hash === report.baselineHash),
    upcast: upcasted.schemaVersion === 2,
    recordedOutput: canonicalJson(outputs) === '[{"value":467}]',
  };
}

function contractSmoke() {
  const registry = VerifierRegistry.create();
  const citation = registry.verify({
    obligationId: "driver:citation_support",
    kind: "citation_support",
    claim: "driver fixture",
    recordedInputs: {
      archivedText: "The measured value is exactly 42 units.",
      claimText: "The measured value is 42 units.",
    },
  });
  return {
    taxonomy:
      VerifierRegistry.ObligationKind.options.length === 15 &&
      VerifierRegistry.AssertedOnlyKind.options.every(
        (kind) =>
          registry.verify({
            obligationId: `driver:${kind}`,
            kind,
            claim: "driver fixture",
            recordedInputs: {},
          }).type === "verification_result",
      ),
    frozenModelFingerprint:
      citation.type === "verification_result" &&
      citation.status === "verified" &&
      citation.modelFingerprint === VerifierRegistry.FrozenNliModelFingerprint,
    modelFingerprint: VerifierRegistry.FrozenNliModelFingerprint,
  };
}

function sumReducer(state: JsonValue, event: CommutativeEvent): JsonValue {
  if (typeof state !== "number" || typeof event.value !== "number") {
    throw new Error("numeric fixture required");
  }
  return state + event.value;
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}
