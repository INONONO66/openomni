import {
  type VerifierRegistryDriverExecution,
  VerifierRegistryDriverScenarios,
  driverExecution,
} from "./verifier-registry-driver-contract.js";
import { scenarioReceipt } from "./verifier-registry-driver-scenarios.js";
import {
  executeVerifierRegistryBenchmark,
  executeVerifierRegistrySelfTest,
} from "./verifier-registry-driver-self-test.js";

export type {
  VerifierRegistryDriverExecution,
  VerifierRegistryDriverScenario,
} from "./verifier-registry-driver-contract.js";

export function runVerifierRegistryDriver(
  args: readonly string[],
): VerifierRegistryDriverExecution {
  try {
    if (args.length === 1 && args[0] === "--help") {
      return Object.freeze({
        exitCode: 0,
        stdout:
          "Usage: verifier-registry-driver --self-test | --benchmark | --scenario <name> --json",
      });
    }
    if (args.length === 1 && args[0] === "--self-test") {
      return executeVerifierRegistrySelfTest();
    }
    if (args.length === 1 && args[0] === "--benchmark") {
      return executeVerifierRegistryBenchmark();
    }
    if (args.length === 3 && args[0] === "--scenario" && args[2] === "--json") {
      const scenario = VerifierRegistryDriverScenarios.find((value) => value === args[1]);
      if (scenario !== undefined) {
        const receipt = scenarioReceipt(scenario);
        return driverExecution(receipt.ok, receipt);
      }
    }
    return driverExecution(false, {
      version: "verifier-registry-driver-v1",
      mode: "argument_error",
      ok: false,
      resultCode: "invalid_arguments",
    });
  } catch {
    return driverExecution(false, {
      version: "verifier-registry-driver-v1",
      mode: "driver_error",
      ok: false,
      resultCode: "driver_threw",
    });
  }
}
