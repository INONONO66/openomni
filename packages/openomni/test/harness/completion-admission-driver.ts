import { Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  CompletionAdmissionDriverScenarios,
  type CompletionAdmissionDriverScenario,
  CompletionAdmissionDriverVersion,
  runCompletionAdmissionScenario,
} from "./completion-admission-driver-scenarios.js";

const USAGE = `Usage: completion-admission-driver --self-test | --scenario <${CompletionAdmissionDriverScenarios.join("|")}> --json`;

export type CompletionAdmissionDriverExecution = Readonly<{
  exitCode: 0 | 1;
  stdout: string;
}>;

export { CompletionAdmissionDriverScenarios };
export type { CompletionAdmissionDriverScenario };

export async function runCompletionAdmissionDriver(
  argumentsInput: readonly string[],
): Promise<CompletionAdmissionDriverExecution> {
  try {
    if (argumentsInput.length === 1 && argumentsInput[0] === "--help") {
      return { exitCode: 0, stdout: USAGE };
    }
    if (argumentsInput.length === 1 && argumentsInput[0] === "--self-test") {
      return selfTest();
    }
    if (
      argumentsInput.length === 3 &&
      argumentsInput[0] === "--scenario" &&
      argumentsInput[2] === "--json" &&
      isScenario(argumentsInput[1])
    ) {
      const receipt = await runIsolatedScenario(argumentsInput[1]);
      return execution(receipt.ok, receipt);
    }
    return argumentError();
  } catch (error) {
    return execution(false, {
      version: CompletionAdmissionDriverVersion,
      mode: "driver_error",
      ok: false,
      resultCode: "driver_threw",
      errorType: error instanceof Error ? error.name : "NonError",
    });
  }
}

async function selfTest(): Promise<CompletionAdmissionDriverExecution> {
  const scenarios: Array<{
    scenario: CompletionAdmissionDriverScenario;
    runs: 2;
    deterministic: boolean;
    resultCode: string;
    ok: boolean;
  }> = [];
  let allPassed = true;
  for (const scenario of CompletionAdmissionDriverScenarios) {
    const first = await runIsolatedScenario(scenario);
    const second = await runIsolatedScenario(scenario);
    const deterministic = JSON.stringify(first) === JSON.stringify(second);
    const passed = first.ok && second.ok && deterministic;
    if (!passed) allPassed = false;
    scenarios.push({
      scenario,
      runs: 2,
      deterministic,
      resultCode: first.resultCode,
      ok: passed,
    });
  }
  return execution(allPassed, {
    version: CompletionAdmissionDriverVersion,
    mode: "self_test",
    ok: allPassed,
    resultCode: allPassed ? "self_test_passed" : "self_test_failed",
    scenarioRuns: CompletionAdmissionDriverScenarios.length * 2,
    deterministic: scenarios.every(({ deterministic }) => deterministic),
    scenarios,
  });
}

function runIsolatedScenario(scenario: CompletionAdmissionDriverScenario) {
  return Bus.withIsolation(() =>
    Storage.withIsolation(() => runCompletionAdmissionScenario(scenario)),
  );
}

function isScenario(value: string | undefined): value is CompletionAdmissionDriverScenario {
  return CompletionAdmissionDriverScenarios.some((scenario) => scenario === value);
}

function argumentError(): CompletionAdmissionDriverExecution {
  return execution(false, {
    version: CompletionAdmissionDriverVersion,
    mode: "argument_error",
    ok: false,
    resultCode: "invalid_arguments",
  });
}

function execution(ok: boolean, receipt: object): CompletionAdmissionDriverExecution {
  return Object.freeze({ exitCode: ok ? 0 : 1, stdout: JSON.stringify(receipt) });
}

if (import.meta.main) {
  const result = await runCompletionAdmissionDriver(Bun.argv.slice(2));
  process.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}
