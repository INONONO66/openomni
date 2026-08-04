import { Tool } from "@openomni/protocol";
import { canonicalJson } from "./verifier-conformance.js";
import type {
  VerifierRegistryDriverScenario,
  VerifierRegistryScenarioObservation,
  VerifierRegistryScenarioReceipt,
} from "./verifier-registry-driver-contract.js";
import { VerifierRegistry } from "./verifier-registry.js";

const nativeCall = Object.freeze({
  id: "call-native-467",
  tool: "read",
  input: Object.freeze({ path: "evidence.json", offset: 1, limit: 20 }),
});

export function scenarioReceipt(
  scenario: VerifierRegistryDriverScenario,
): VerifierRegistryScenarioReceipt {
  const registry = VerifierRegistry.create();
  let observation: VerifierRegistryScenarioObservation;
  let ok = false;
  let resultCode: string;

  if (scenario === "valid-native-round-trip") {
    const nativeJson: unknown = JSON.parse(JSON.stringify(nativeCall));
    const roundTrip = Tool.Call.parse(nativeJson);
    const fact = registry.verify(
      obligation("schema_validity", {
        schema: "native_tool_call",
        value: VerifierRegistry.JsonValue.parse(roundTrip),
      }),
    );
    const roundTripEqual = canonicalJson(roundTrip) === canonicalJson(nativeCall);
    observation = { fact, nativeCall: roundTrip, roundTripEqual };
    ok = roundTripEqual && isResult(fact, "verified");
    resultCode = ok ? "valid_native_round_trip" : "valid_native_round_trip_failed";
  } else if (scenario === "malformed-schema") {
    const fact = registry.verify(
      obligation("schema_validity", {
        schema: "invalid_native_schema",
        value: nativeCall,
      }),
    );
    observation = { fact };
    ok = isError(fact, "malformed_input");
    resultCode = ok ? "malformed_schema" : "malformed_schema_failed";
  } else if (scenario === "known-bad-predicate") {
    const fact = registry.verify(
      obligation("numeric_recheck", { operator: "lt", left: 4, right: 2 }),
    );
    observation = { fact };
    ok = isResult(fact, "refuted") && fact.checkedPredicate !== undefined;
    resultCode = ok ? "known_bad_refuted" : "known_bad_not_refuted";
  } else if (scenario === "prohibited-capability") {
    const fact = registry.verify(request(["network"], []));
    observation = { fact };
    ok = isError(fact, "prohibited_capability") && fact.violation === "network";
    resultCode = ok ? "prohibited_capability" : "capability_not_prohibited";
  } else if (scenario === "forbidden-action") {
    const fact = registry.verify(request([], ["persist"]));
    observation = { fact };
    ok = isError(fact, "forbidden_action") && fact.violation === "persist";
    resultCode = ok ? "forbidden_action" : "action_not_forbidden";
  } else {
    return assertNever(scenario);
  }

  return {
    version: "verifier-registry-driver-v1",
    mode: "scenario",
    scenario,
    ok,
    resultCode,
    observation,
  };
}

function assertNever(value: never): never {
  throw new Error(`unhandled verifier driver scenario: ${String(value)}`);
}

function obligation(
  kind: VerifierRegistry.ObligationKind,
  recordedInputs: VerifierRegistry.JsonValue,
) {
  return {
    obligationId: `driver:${kind}`,
    kind,
    claim: "driver fixture",
    recordedInputs,
  };
}

function request(
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

function isResult(
  fact: VerifierRegistry.VerificationFact,
  status: VerifierRegistry.ResultStatus,
): fact is VerifierRegistry.VerificationResult {
  return fact.type === "verification_result" && fact.status === status;
}

function isError(
  fact: VerifierRegistry.VerificationFact,
  code: VerifierRegistry.VerificationError["code"],
): fact is VerifierRegistry.VerificationError {
  return fact.type === "verification_error" && fact.code === code;
}
