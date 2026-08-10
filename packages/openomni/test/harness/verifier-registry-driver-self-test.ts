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
} from "../../src/evidence/verifier-conformance.js";
import { measureVerifierRegistryBenchmark } from "./verifier-registry-benchmark.js";
import {
  type VerifierRegistryDriverExecution,
  type VerifierRegistryDriverScenario,
  type VerifierRegistryScenarioReceipt,
  VerifierRegistryDriverScenarios,
  driverExecution,
} from "./verifier-registry-driver-contract.js";
import { scenarioReceipt } from "./verifier-registry-driver-scenarios.js";
import { VerifierRegistry } from "../../src/evidence/verifier-registry.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

export function executeVerifierRegistrySelfTest(): VerifierRegistryDriverExecution {
  return executeVerifierRegistryCheck(false);
}

export function executeVerifierRegistryBenchmark(): VerifierRegistryDriverExecution {
  return executeVerifierRegistryCheck(true);
}

function executeVerifierRegistryCheck(includeLatency: boolean): VerifierRegistryDriverExecution {
  const durations: number[] = [];
  const run = (): VerifierRegistryScenarioReceipt[] =>
    VerifierRegistryDriverScenarios.map((scenario) => {
      const started = includeLatency ? performance.now() : 0;
      const receipt = scenarioReceipt(scenario);
      if (includeLatency) durations.push(performance.now() - started);
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
  const measured = measureVerifierRegistryBenchmark(first);
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const successCount = first.filter(
    (receipt, index) => receipt.ok && second[index]?.ok === true,
  ).length;
  const runSuccessCount = [...first, ...second].filter((receipt) => receipt.ok).length;
  const action =
    measured.exposedActions.length === 0 &&
    measured.exposedCapabilities.length === 0 &&
    VerifierRegistryDriverScenarios.every((scenario) => {
      const firstCode = resultCodeOf(first, scenario);
      return firstCode !== undefined && firstCode === resultCodeOf(second, scenario);
    });
  const ok =
    decision &&
    signature &&
    action &&
    successCount === VerifierRegistryDriverScenarios.length &&
    conformance.replayKey &&
    conformance.fingerprint &&
    conformance.manifest &&
    conformance.command &&
    conformance.interleaving &&
    conformance.upcast &&
    conformance.recordedOutput &&
    contracts.taxonomy &&
    contracts.frozenModelFingerprint &&
    measured.accuracy.rate === 1 &&
    measured.trust.decisiveCount === measured.trust.basisBoundCount &&
    measured.trust.decisiveCount === measured.trust.predicateBoundCount &&
    Object.values(measured.toolValidity).every(Boolean);

  return driverExecution(ok, {
    version: "verifier-registry-driver-v1",
    mode: includeLatency ? "benchmark" : "self_test",
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
        divergence: conformance.commandDivergenceKind === "command_mismatch",
      },
      reliability: {
        k: 2,
        fixtureCount: first.length,
        passToKSuccesses: successCount,
        passToKRate: successCount / first.length,
        successRate: runSuccessCount / (first.length + second.length),
      },
      taxonomy: measured.taxonomy,
      accuracy: measured.accuracy,
      trust: measured.trust,
      toolValidity: measured.toolValidity,
      ...(includeLatency
        ? {
            latencyMs: {
              measuredBy: "outer_driver_harness",
              samples: durations.length,
              p50: percentile(sortedDurations, 0.5),
              p95: percentile(sortedDurations, 0.95),
            },
          }
        : {}),
      surface: measured.surface,
    },
    exposedActions: measured.exposedActions,
    exposedCapabilities: measured.exposedCapabilities,
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
  let commandConverged = true;
  try {
    assertReplayConformance(trace, trace);
  } catch {
    commandConverged = false;
  }
  let commandDivergenceKind = "none";
  try {
    assertReplayConformance(trace, {
      commands: [{ op: "read", id: 468 }],
      finalFold: trace.finalFold,
    });
  } catch (error) {
    if (error instanceof ReplayConformanceError) {
      commandDivergenceKind = error.facts.kind;
    }
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
    command: commandConverged && commandDivergenceKind === "command_mismatch",
    commandDivergenceKind,
    interleaving: report.interleavingHashes.every((hash) => hash === report.baselineHash),
    upcast: upcasted.schemaVersion === 2,
    recordedOutput: canonicalJson(outputs) === '[{"value":467}]',
  };
}

function resultCodeOf(
  receipts: readonly VerifierRegistryScenarioReceipt[],
  scenario: VerifierRegistryDriverScenario,
): string | undefined {
  return receipts.find((receipt) => receipt.scenario === scenario)?.resultCode;
}

function contractSmoke() {
  const registry = VerifierRegistry.create();
  const citation = registry.verify({
    obligationId: "driver:citation_support",
    kind: "citation_support",
    claim: "The measured value is 42 units.",
    recordedInputs: {
      archivedText: "The measured value is exactly 42 units.",
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
