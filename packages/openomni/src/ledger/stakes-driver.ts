import { z } from "zod";
import { runStakesScenario, type StakesDriverScenario } from "./stakes-driver-scenarios.js";

const argumentsSchema = z.array(z.string()).max(3).readonly();
const scenarios = ["threshold-and-split", "forged-local-value"] as const;

export type StakesDriverExecution = {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
};

export function runStakesDriver(argumentsInput: unknown): StakesDriverExecution {
  try {
    const parsed = argumentsSchema.safeParse(argumentsInput);
    if (!parsed.success) return argumentError();
    const args = parsed.data;
    if (args.length === 1 && args[0] === "--help") {
      return {
        exitCode: 0,
        stdout: "Usage: stakes-driver --scenario <threshold-and-split|forged-local-value> --json",
      };
    }
    if (
      args.length !== 3 ||
      args[0] !== "--scenario" ||
      !isScenario(args[1]) ||
      args[2] !== "--json"
    ) {
      return argumentError();
    }
    const receipt = runStakesScenario(args[1]);
    return { exitCode: receipt.ok === true ? 0 : 1, stdout: JSON.stringify(receipt) };
  } catch {
    return {
      exitCode: 1,
      stdout: JSON.stringify({
        version: "stakes-driver-v1",
        mode: "driver_error",
        ok: false,
        resultCode: "driver_threw",
      }),
    };
  }
}

function isScenario(value: string | undefined): value is StakesDriverScenario {
  return value !== undefined && scenarios.some((scenario) => scenario === value);
}

function argumentError(): StakesDriverExecution {
  return {
    exitCode: 1,
    stdout: JSON.stringify({
      version: "stakes-driver-v1",
      mode: "argument_error",
      ok: false,
      resultCode: "invalid_arguments",
    }),
  };
}

if (import.meta.main) {
  const result = runStakesDriver(Bun.argv.slice(2));
  await Bun.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}
