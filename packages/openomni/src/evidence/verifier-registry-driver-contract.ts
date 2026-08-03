import { Tool } from "@openomni/protocol";
import { z } from "zod";
import { VerifierRegistry } from "./verifier-registry.js";

export const VerifierRegistryDriverScenarios = [
  "valid-native-round-trip",
  "malformed-schema",
  "known-bad-predicate",
  "prohibited-capability",
  "forbidden-action",
] as const;

export type VerifierRegistryDriverScenario = (typeof VerifierRegistryDriverScenarios)[number];
export const VerifierRegistryDriverScenario = z.enum(VerifierRegistryDriverScenarios);

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
export const VerifierRegistryScenarioReceiptSchema = z
  .object({
    version: z.literal("verifier-registry-driver-v1"),
    mode: z.literal("scenario"),
    scenario: VerifierRegistryDriverScenario,
    ok: z.boolean(),
    resultCode: z.string().min(1),
    observation: z
      .object({
        fact: VerifierRegistry.VerificationFact,
        nativeCall: Tool.Call.optional(),
        roundTripEqual: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const VerifierRegistryDriverSurface = Object.freeze({
  toolNames: Object.freeze(["verifier_registry_driver"]),
  fieldNames: Object.freeze(["version", "mode", "scenario", "ok", "resultCode", "observation"]),
  tokens: Object.freeze([
    "--self-test",
    "--scenario",
    "--json",
    "--help",
    ...VerifierRegistryDriverScenarios,
  ]),
});

export function driverExecution(
  ok: boolean,
  receipt: Readonly<Record<string, unknown>>,
): VerifierRegistryDriverExecution {
  return {
    exitCode: ok ? 0 : 1,
    stdout: JSON.stringify(receipt),
  };
}
