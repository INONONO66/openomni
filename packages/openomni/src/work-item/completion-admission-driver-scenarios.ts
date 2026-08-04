import { runLegacyArchiveCompletionAdmissionScenario } from "./completion-admission-driver-archive-scenarios.js";
import { runAllOriginsCompletionAdmissionScenario } from "./completion-admission-driver-origin-scenarios.js";
import {
  runAssertedCompletionAdmissionScenario,
  runKnownBadCompletionAdmissionScenario,
} from "./completion-admission-driver-authority-scenarios.js";
import type {
  CompletionAdmissionDriverScenario,
  CompletionAdmissionScenarioReceipt,
} from "./completion-admission-driver-contract.js";
import {
  runBypassRefusalCompletionAdmissionScenario,
  runRestartRecoveryCompletionAdmissionScenario,
  runStaleBasisCompletionAdmissionScenario,
} from "./completion-admission-driver-storage-scenarios.js";

export async function runCompletionAdmissionScenario(
  scenario: CompletionAdmissionDriverScenario,
): Promise<CompletionAdmissionScenarioReceipt> {
  switch (scenario) {
    case "known-bad":
      return runKnownBadCompletionAdmissionScenario();
    case "low-asserted-high-escalation":
      return runAssertedCompletionAdmissionScenario();
    case "all-origins":
      return runAllOriginsCompletionAdmissionScenario();
    case "stale-basis":
      return runStaleBasisCompletionAdmissionScenario();
    case "restart-recovery":
      return runRestartRecoveryCompletionAdmissionScenario();
    case "bypass-refusal":
      return runBypassRefusalCompletionAdmissionScenario();
    case "legacy-archive":
      return runLegacyArchiveCompletionAdmissionScenario();
  }
}
