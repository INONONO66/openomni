import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEngine } from "@openomni/policy";
import { WorkItem } from "@openomni/protocol";
import { Bus, SqliteStorageAdapter, Storage, WorkItemStore } from "@openomni/session";
import {
  CompletionAdmissionError,
  createCompletionAuthorityResolver,
} from "./completion-admission-authority.js";
import {
  CompletionAdmissionServiceError,
  createCompletionAdmissionService,
} from "./completion-admission-boundary.js";
import { completionAdmissionScenarioReceipt } from "./completion-admission-driver-contract.js";
import {
  CompletionAdmissionDriverNow,
  captureCompletionAdmissionDriverCode,
  captureCompletionAdmissionDriverMessage,
  completionAdmissionDriverAssertedPolicy,
  completionAdmissionDriverAssertedResult,
  completionAdmissionDriverCriterion,
  completionAdmissionDriverReport,
  completionAdmissionDriverRequest,
  completionAdmissionDriverWorkItem,
  insertCompletionAdmissionDriverItem,
  requiredCompletionAdmissionDriverItem,
  withCompletionAdmissionDriverStorage,
} from "./completion-admission-driver-fixtures.js";

export async function runStaleBasisCompletionAdmissionScenario() {
  return withCompletionAdmissionDriverStorage(async (adapter) => {
    const item = completionAdmissionDriverWorkItem("wi_driver_stale_basis", [
      "Current basis remains authoritative",
    ]);
    insertCompletionAdmissionDriverItem(adapter, item);
    const request = WorkItem.CompletionRequest.parse({
      ...completionAdmissionDriverRequest(item, "request:driver-stale-basis"),
      basisRef: "basis:stale-driver",
    });
    const resolver = createCompletionAuthorityResolver({
      policyEngine: PolicyEngine.create(),
      now: () => CompletionAdmissionDriverNow,
    });
    const authorityErrorCode = await captureCompletionAdmissionDriverCode(
      resolver.resolve(item, request),
      CompletionAdmissionError,
    );
    const service = createCompletionAdmissionService({
      authorityResolver: resolver,
      now: () => CompletionAdmissionDriverNow,
    });
    const before = requiredCompletionAdmissionDriverItem(item.hash);
    const errorCode = await captureCompletionAdmissionDriverCode(
      service.requestCompletion(request, completionAdmissionDriverReport(item)),
      CompletionAdmissionServiceError,
    );
    const after = requiredCompletionAdmissionDriverItem(item.hash);
    const status = WorkItem.deriveStatus(after);
    const admissionCount = after.completionFacts.admissions.length;
    const terminalAppendCount = Number(after.completionTerminalReceipt !== undefined);
    const ok =
      authorityErrorCode === "stale_basis" &&
      errorCode === "stale_basis" &&
      JSON.stringify(before) === JSON.stringify(after) &&
      admissionCount === 0 &&
      terminalAppendCount === 0;

    return completionAdmissionScenarioReceipt(
      "stale-basis",
      ok,
      "stale_basis_refused",
      "stale_basis_mutated_state",
      { authorityErrorCode, errorCode, admissionCount, terminalAppendCount, status },
    );
  });
}

export async function runRestartRecoveryCompletionAdmissionScenario() {
  const directory = mkdtempSync(join(tmpdir(), "openomni-completion-admission-"));
  const databasePath = join(directory, "work-item.sqlite");
  let activeAdapter: SqliteStorageAdapter | undefined;
  let fields:
    | Readonly<{
        admissionRecordedBeforeRestart: boolean;
        admissionId: string;
        resumedAdmissionId: string;
        reusedOriginalAdmissionId: boolean;
        terminalReceiptLinked: boolean;
        status: WorkItem.Status;
      }>
    | undefined;
  try {
    Bus.reset();
    activeAdapter = new SqliteStorageAdapter(databasePath);
    Storage.configure(activeAdapter);
    const item = completionAdmissionDriverWorkItem("wi_driver_restart_recovery", [
      "Recovery criterion is asserted",
    ]);
    insertCompletionAdmissionDriverItem(activeAdapter, item);
    const criterion = completionAdmissionDriverCriterion(item, 0);
    const result = completionAdmissionDriverAssertedResult(
      item,
      criterion,
      "result:driver-restart",
      ["restart fixture assertion remains unverified"],
    );
    const request = completionAdmissionDriverRequest(item, "request:driver-restart", {
      results: [result],
    });
    const service = createCompletionAdmissionService({
      authorityResolver: createCompletionAuthorityResolver({
        policyEngine: completionAdmissionDriverAssertedPolicy(criterion.id),
        now: () => CompletionAdmissionDriverNow,
      }),
      now: () => CompletionAdmissionDriverNow,
    });
    await captureCompletionAdmissionDriverMessage(
      service.requestCompletion(request, {
        ...completionAdmissionDriverReport(item),
        claims: [{ statement: criterion.statement, evidenceIds: ["evidence:missing"] }],
      }),
      "completion report references missing evidence",
    );
    const recorded = requiredCompletionAdmissionDriverItem(item.hash);
    const admission = recorded.completionFacts.admissions[0];
    if (!admission) throw new Error("restart scenario did not record admission");
    const admissionId = admission.id;
    const admissionRecordedBeforeRestart =
      WorkItem.deriveStatus(recorded) !== "completed" &&
      recorded.completionTerminalReceipt === undefined;

    activeAdapter.close();
    activeAdapter = undefined;
    Storage.reset();

    activeAdapter = new SqliteStorageAdapter(databasePath);
    Storage.configure(activeAdapter);
    const resumedService = createCompletionAdmissionService({
      authorityResolver: createCompletionAuthorityResolver({
        policyEngine: completionAdmissionDriverAssertedPolicy(criterion.id),
        now: () => CompletionAdmissionDriverNow,
      }),
      now: () => CompletionAdmissionDriverNow,
    });
    await resumedService.resumeCompletion(
      item.hash,
      admissionId,
      completionAdmissionDriverReport(item),
    );
    const completed = requiredCompletionAdmissionDriverItem(item.hash);
    const resumedAdmissionId = completed.completionFacts.admissions[0]?.id ?? "missing";
    fields = {
      admissionRecordedBeforeRestart,
      admissionId,
      resumedAdmissionId,
      reusedOriginalAdmissionId: resumedAdmissionId === admissionId,
      terminalReceiptLinked: completed.completionTerminalReceipt?.admissionId === admissionId,
      status: WorkItem.deriveStatus(completed),
    };
  } finally {
    activeAdapter?.close();
    Storage.reset();
    Bus.reset();
    rmSync(directory, { recursive: true, force: true });
  }
  if (!fields) throw new Error("restart scenario did not produce a receipt");
  const temporaryResourcesRemoved = !existsSync(directory);
  const ok =
    fields.admissionRecordedBeforeRestart &&
    fields.reusedOriginalAdmissionId &&
    fields.terminalReceiptLinked &&
    fields.status === "completed" &&
    temporaryResourcesRemoved;

  return completionAdmissionScenarioReceipt(
    "restart-recovery",
    ok,
    "restart_recovery_linked",
    "restart_recovery_failed",
    {
      storage: "filesystem_sqlite",
      ...fields,
      storageReset: true,
      storageReopened: true,
      temporaryResourcesRemoved,
    },
  );
}

export async function runBypassRefusalCompletionAdmissionScenario() {
  return withCompletionAdmissionDriverStorage(async (adapter) => {
    const item = completionAdmissionDriverWorkItem("wi_driver_bypass_refusal", [
      "Completion uses admission authority",
    ]);
    insertCompletionAdmissionDriverItem(adapter, item);
    const before = requiredCompletionAdmissionDriverItem(item.hash);
    const errorCode = await captureCompletionAdmissionDriverCode(
      WorkItemStore.complete(item.hash, completionAdmissionDriverReport(item)),
      Error,
    );
    const after = requiredCompletionAdmissionDriverItem(item.hash);
    const status = WorkItem.deriveStatus(after);
    const terminalMutation =
      after.completionTerminalReceipt !== undefined || after.timestamps.completed !== undefined;
    const ok =
      errorCode === "admission_required" &&
      JSON.stringify(before) === JSON.stringify(after) &&
      !terminalMutation &&
      after.completionFacts.admissions.length === 0;

    return completionAdmissionScenarioReceipt(
      "bypass-refusal",
      ok,
      "bypass_refused",
      "bypass_was_not_refused",
      {
        errorCode,
        terminalMutation,
        admissionCount: after.completionFacts.admissions.length,
        status,
      },
    );
  });
}
