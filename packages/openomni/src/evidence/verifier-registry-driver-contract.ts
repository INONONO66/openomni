import type { Tool } from "@openomni/protocol";
import type { VerifierRegistry } from "./verifier-registry.js";

export const VerifierRegistryDriverScenarios = [
  "valid-native-round-trip",
  "malformed-schema",
  "known-bad-predicate",
  "prohibited-capability",
  "forbidden-action",
] as const;

export type VerifierRegistryDriverScenario = (typeof VerifierRegistryDriverScenarios)[number];

export type VerifierRegistryDriverExecution = Readonly<{
  exitCode: 0 | 1;
  stdout: string;
}>;

export type VerifierRegistryScenarioObservation = Readonly<{
  fact: VerifierRegistry.VerificationFact;
  nativeCall?: Tool.Call;
  roundTripEqual?: boolean;
}>;

export type VerifierRegistryScenarioReceipt = Readonly<{
  version: "verifier-registry-driver-v1";
  mode: "scenario";
  scenario: VerifierRegistryDriverScenario;
  ok: boolean;
  resultCode: string;
  observation: VerifierRegistryScenarioObservation;
}>;

export function driverExecution(
  ok: boolean,
  receipt: Readonly<Record<string, unknown>>,
): VerifierRegistryDriverExecution {
  return {
    exitCode: ok ? 0 : 1,
    stdout: JSON.stringify(receipt),
  };
}
