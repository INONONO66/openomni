export const CompletionAdmissionDriverVersion = "completion-admission-driver-v1" as const;

export const CompletionAdmissionDriverScenarios = [
  "known-bad",
  "low-asserted-high-escalation",
  "all-origins",
  "stale-basis",
  "restart-recovery",
  "bypass-refusal",
  "legacy-archive",
] as const;
export type CompletionAdmissionDriverScenario = (typeof CompletionAdmissionDriverScenarios)[number];

export type CompletionAdmissionScenarioReceipt = Readonly<{
  version: typeof CompletionAdmissionDriverVersion;
  mode: "scenario";
  scenario: CompletionAdmissionDriverScenario;
  ok: boolean;
  resultCode: string;
  [field: string]: unknown;
}>;

export function completionAdmissionScenarioReceipt(
  scenario: CompletionAdmissionDriverScenario,
  ok: boolean,
  successCode: string,
  failureCode: string,
  fields: Readonly<Record<string, unknown>>,
): CompletionAdmissionScenarioReceipt {
  return Object.freeze({
    version: CompletionAdmissionDriverVersion,
    mode: "scenario" as const,
    scenario,
    ok,
    resultCode: ok ? successCode : failureCode,
    ...fields,
  });
}
