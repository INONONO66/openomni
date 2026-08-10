import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEngine } from "@openomni/policy";
import { WorkItem } from "@openomni/protocol";
import { Bus, SqliteStorageAdapter, Storage, WorkItemStore } from "@openomni/session";
import { createDefaultDispatchRuntime } from "../../src/dispatch/setup.js";
import { VerifierRegistry } from "../../src/evidence/verifier-registry.js";
import {
  CompletionAdmissionError,
  type CompletionResultAuthorityPort,
  type CompletionStakesResolver,
  completionRequestRoot,
  createCompletionAdmissionService,
  createCompletionDecision,
} from "../../src/work-item/completion-admission.js";
import {
  CompletionAdmissionDriverNow,
  captureCompletionAdmissionDriverCode,
  captureCompletionAdmissionDriverMessage,
  completionAdmissionDriverAssertedPolicy,
  completionAdmissionDriverCriterion,
  completionAdmissionDriverCriterionResult,
  completionAdmissionDriverObservation,
  completionAdmissionDriverProposedFacts,
  completionAdmissionDriverReport,
  completionAdmissionDriverRequest,
  completionAdmissionDriverStakes,
  completionAdmissionDriverStakesResolver,
  completionAdmissionDriverVerifierPort,
  completionAdmissionDriverWorkItem,
  insertCompletionAdmissionDriverItem,
  requiredCompletionAdmissionDriverItem,
  withCompletionAdmissionDriverStorage,
} from "./completion-admission-driver-fixtures.js";
import { evaluateCompletion } from "../../src/work-item/completion-admission-fold.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const CompletionAdmissionDriverVersion = "completion-admission-driver-v1" as const;

export const CompletionAdmissionDriverScenarios = [
  "known-bad",
  "low-asserted-high-escalation",
  "all-origins",
  "stale-basis",
  "restart-recovery",
  "bypass-refusal",
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
    ...fields,
    version: CompletionAdmissionDriverVersion,
    mode: "scenario" as const,
    scenario,
    ok,
    resultCode: ok ? successCode : failureCode,
  });
}

// ---------------------------------------------------------------------------
// Scenario dispatch
// ---------------------------------------------------------------------------

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
  }
}

function completionAdmissionDriverService(
  completionWriter: Storage.WorkItemCompletionWriter,
  authority: Readonly<{
    policyEngine?: ReturnType<typeof PolicyEngine.create>;
    resultAuthorityPort?: CompletionResultAuthorityPort;
    stakesResolver?: CompletionStakesResolver;
  }> = {},
) {
  const now = () => CompletionAdmissionDriverNow;
  const resolver = createCompletionDecision({
    policyEngine: authority.policyEngine ?? PolicyEngine.create(),
    ...(authority.resultAuthorityPort === undefined
      ? {}
      : { resultAuthorityPort: authority.resultAuthorityPort }),
    ...(authority.stakesResolver === undefined ? {} : { stakesResolver: authority.stakesResolver }),
    now,
  });
  const service = createCompletionAdmissionService({ completionWriter, decision: resolver, now });
  return { service, resolver };
}

// ---------------------------------------------------------------------------
// Authority scenarios
// ---------------------------------------------------------------------------

async function runKnownBadCompletionAdmissionScenario() {
  return withCompletionAdmissionDriverStorage(async (adapter, completionWriter) => {
    const item = completionAdmissionDriverWorkItem("wi_driver_known_bad", [
      "recorded numeric operands satisfy lt",
    ]);
    insertCompletionAdmissionDriverItem(adapter, item);
    const criterion = completionAdmissionDriverCriterion(item, 0);
    const verification = VerifierRegistry.create().verify({
      obligationId: "obligation:driver-known-bad",
      kind: "numeric_recheck",
      claim: criterion.statement,
      recordedInputs: { operator: "lt", left: 4, right: 2 },
    });
    if (
      verification.type !== "verification_result" ||
      verification.status !== "refuted" ||
      verification.checkedPredicate === undefined
    ) {
      throw new Error(`known-bad verifier returned ${verification.type}`);
    }
    const checkedPredicate = verification.checkedPredicate;
    const observation = completionAdmissionDriverObservation(item, "observation:driver-known-bad", {
      producer: verification.verifierId,
      artifactRefs: [],
      provenanceRef: verification.basisHash,
    });
    const result = completionAdmissionDriverCriterionResult(
      item,
      criterion,
      "result:driver-known-bad",
      {
        value: "refuted",
        checkedPredicate,
        observationIds: [observation.id],
        verifierRef: verification.verifierId,
      },
    );
    const request = completionAdmissionDriverRequest(item, "request:driver-known-bad", {
      observations: [observation],
      results: [result],
    });
    const foldAdmission = evaluateCompletion({
      admissionId: "admission:driver-known-bad:fold",
      requestId: request.id,
      requestRoot: completionRequestRoot(request),
      sourceIdentity: request.sourceIdentity,
      origin: request.origin,
      workItemHash: item.hash,
      contractRevision: item.completionContract.revision,
      basisRef: item.completionContract.basisRef,
      expectedHead: item.revision,
      createdAt: CompletionAdmissionDriverNow,
      durableFacts: item.completionFacts,
      proposedFacts: completionAdmissionDriverProposedFacts(request),
      blockers: item.blockers,
      currentAttempt: item.attempt,
      policy: {
        policyRef: "policy:driver-default",
        verdict: "allow",
        allowedAssertedCriterionIds: [],
        reasonCodes: [],
      },
    });
    const { service } = completionAdmissionDriverService(completionWriter, {
      resultAuthorityPort: completionAdmissionDriverVerifierPort(criterion, result, [observation]),
    });
    const outcome = await service.requestCompletion(request, completionAdmissionDriverReport(item));
    const stored = requiredCompletionAdmissionDriverItem(item.hash);
    const status = WorkItem.deriveStatus(stored);
    const blocked =
      outcome.admission.decision === "block" &&
      status !== "completed" &&
      stored.completionTerminalReceipt === undefined;
    const completionStatus = blocked ? "incomplete" : status;
    const predicateBoundToCriterion = checkedPredicate === criterion.statement;
    const ok =
      verification.status === "refuted" &&
      checkedPredicate.length > 0 &&
      predicateBoundToCriterion &&
      foldAdmission.decision === "block" &&
      blocked &&
      completionStatus === "incomplete" &&
      stored.completionFacts.effects.length === 0 &&
      stored.completionFacts.admissions.length === 1;

    return completionAdmissionScenarioReceipt(
      "known-bad",
      ok,
      "known_bad_blocked",
      "known_bad_failed",
      {
        blocked,
        status: completionStatus,
        verifier: verification.verifierId,
        result: { value: result.value, checkedPredicate },
        predicateBoundToCriterion,
        foldDecision: foldAdmission.decision,
        admission: {
          id: outcome.admission.id,
          decision: outcome.admission.decision,
          reasonCodes: outcome.admission.reasonCodes,
        },
        workItem: {
          status,
          completed: status === "completed",
          effectCount: stored.completionFacts.effects.length,
          admissionCount: stored.completionFacts.admissions.length,
          terminalReceiptLinked: stored.completionTerminalReceipt !== undefined,
        },
      },
    );
  });
}

async function runAssertedCompletionAdmissionScenario() {
  const lowItem = completionAdmissionDriverWorkItem("wi_driver_low_asserted", [
    "Low-risk criterion is claimed",
  ]);
  const lowCriterion = completionAdmissionDriverCriterion(lowItem, 0);
  const lowRisk = "claimant assertion remains independently unverified";
  const lowResult = completionAdmissionDriverCriterionResult(
    lowItem,
    lowCriterion,
    "result:driver-low",
    {
      value: "asserted",
      assumptions: ["claimant supplied this assertion"],
      residualRisks: [lowRisk],
    },
  );
  const lowRequest = completionAdmissionDriverRequest(lowItem, "request:driver-low", {
    results: [lowResult],
  });
  const withoutPolicy = await createCompletionDecision({
    policyEngine: PolicyEngine.create(),
    now: () => CompletionAdmissionDriverNow,
  })(lowItem, lowRequest);
  const withPolicy = await createCompletionDecision({
    policyEngine: completionAdmissionDriverAssertedPolicy(lowCriterion.id),
    stakesResolver: completionAdmissionDriverStakesResolver(),
    now: () => CompletionAdmissionDriverNow,
  })(lowItem, lowRequest);

  const highItem = completionAdmissionDriverWorkItem("wi_driver_high_asserted", [
    "High-stakes criterion is claimed",
  ]);
  const highCriterion = completionAdmissionDriverCriterion(highItem, 0);
  const highResult = completionAdmissionDriverCriterionResult(
    highItem,
    highCriterion,
    "result:driver-high",
    {
      value: "asserted",
      assumptions: ["claimant supplied this assertion"],
      residualRisks: ["high-stakes assertion has no independent verification"],
    },
  );
  const highRequest = completionAdmissionDriverRequest(highItem, "request:driver-high", {
    results: [highResult],
  });
  const stakes = completionAdmissionDriverStakes("high");
  const highAdmission = await createCompletionDecision({
    policyEngine: PolicyEngine.create(),
    stakesResolver: completionAdmissionDriverStakesResolver(stakes),
    now: () => CompletionAdmissionDriverNow,
  })(highItem, highRequest);
  const silentlyPromotedToVerified = [lowResult, highResult].some(
    ({ value }) => value === "verified",
  );
  const criterionScopedPolicy =
    withPolicy.reasonCodes.includes("low_risk_asserted_allowed") &&
    withPolicy.effectiveResultIds.includes(lowResult.id) &&
    withPolicy.unresolvedCriterionIds.length === 0;
  const ok =
    withoutPolicy.decision === "block" &&
    withPolicy.decision === "admit" &&
    criterionScopedPolicy &&
    withPolicy.residualRisks.includes(lowRisk) &&
    highAdmission.decision === "escalate" &&
    highAdmission.stakesRef === stakes.reference &&
    (stakes.comparison === "at" || stakes.comparison === "above") &&
    !silentlyPromotedToVerified;

  return completionAdmissionScenarioReceipt(
    "low-asserted-high-escalation",
    ok,
    "asserted_policy_and_stakes_verified",
    "asserted_policy_or_stakes_failed",
    {
      low: {
        criterionId: lowCriterion.id,
        resultValue: lowResult.value,
        withoutPolicyDecision: withoutPolicy.decision,
        withPolicyDecision: withPolicy.decision,
        criterionScopedPolicy,
        policyRef: withPolicy.policyRef,
        residualRisks: withPolicy.residualRisks,
      },
      high: {
        criterionId: highCriterion.id,
        resultValue: highResult.value,
        decision: highAdmission.decision,
        stakesReference: stakes.reference,
        stakesValue: stakes.value,
        stakesComparison: stakes.comparison,
      },
      silentlyPromotedToVerified,
    },
  );
}

// ---------------------------------------------------------------------------
// Origin scenario
// ---------------------------------------------------------------------------

type OriginExpectation = Readonly<{
  source: WorkItem.CompletionSourceOrigin;
  origin: WorkItem.CompletionOrigin;
}>;

type OriginAdmissionReceipt = Readonly<{
  source: string;
  origin: WorkItem.CompletionOrigin;
  admissionOrigin: WorkItem.CompletionOrigin;
  sourceIdentityPersisted: boolean;
  boundaryTraversed: boolean;
  terminalReceiptLinked: boolean;
}>;

const OriginExpectations = [
  {
    source: { source: "resident", identity: { kind: "resident", id: "resident:driver" } },
    origin: "resident",
  },
  { source: { source: "internal_worker" }, origin: "worker" },
  { source: { source: "connector_worker" }, origin: "worker" },
  {
    source: { source: "api", identity: { kind: "external_actor", id: "actor:api-driver" } },
    origin: "external_actor",
  },
  {
    source: { source: "a2a", identity: { kind: "external_actor", id: "actor:a2a-driver" } },
    origin: "external_actor",
  },
  {
    source: { source: "human", identity: { kind: "external_actor", id: "actor:human-driver" } },
    origin: "external_actor",
  },
  {
    source: { source: "sdk", identity: { kind: "resident", id: "resident:driver" } },
    origin: "resident",
  },
  {
    source: { source: "sdk", identity: { kind: "worker", id: "worker:sdk-driver" } },
    origin: "worker",
  },
  {
    source: { source: "sdk", identity: { kind: "external_actor", id: "actor:sdk-driver" } },
    origin: "external_actor",
  },
  {
    source: { source: "internal", identity: { kind: "resident", id: "resident:internal-driver" } },
    origin: "resident",
  },
  {
    source: { source: "internal", identity: { kind: "worker", id: "worker:internal-driver" } },
    origin: "worker",
  },
  {
    source: {
      source: "internal",
      identity: { kind: "external_actor", id: "actor:internal-driver" },
    },
    origin: "external_actor",
  },
  { source: { source: "replay" }, origin: "replay" },
  { source: { source: "recovery" }, origin: "recovery" },
] as const satisfies readonly OriginExpectation[];

const CanonicalOrigins = ["resident", "worker", "external_actor", "replay", "recovery"] as const;

export async function runAllOriginsCompletionAdmissionScenario(
  project: typeof WorkItem.projectCompletionOrigin = WorkItem.projectCompletionOrigin,
) {
  return withCompletionAdmissionDriverStorage(async (adapter, completionWriter) => {
    const sourceReceipts: OriginAdmissionReceipt[] = [];
    for (const [index, expectation] of OriginExpectations.entries()) {
      const origin = project(expectation.source);
      const expectedSourceIdentity = WorkItem.projectCompletionSourceIdentity(expectation.source);
      const item = completionAdmissionDriverWorkItem(`wi_driver_origin_${index}`, [
        `Origin ${index} traverses admission`,
      ]);
      insertCompletionAdmissionDriverItem(adapter, item);
      if (origin !== expectation.origin) {
        sourceReceipts.push({
          source: sourceLabel(expectation.source),
          origin,
          admissionOrigin: origin,
          sourceIdentityPersisted: false,
          boundaryTraversed: false,
          terminalReceiptLinked: false,
        });
        continue;
      }
      const criterion = completionAdmissionDriverCriterion(item, 0);
      const observation = completionAdmissionDriverObservation(
        item,
        `observation:driver-origin:${index}`,
        { producer: "verifier:driver-origin" },
      );
      const result = completionAdmissionDriverCriterionResult(
        item,
        criterion,
        `result:driver-origin:${index}`,
        {
          value: "verified",
          checkedPredicate: criterion.statement,
          observationIds: [observation.id],
          verifierRef: "verifier:driver-origin",
        },
      );
      const request = WorkItem.CompletionRequest.parse({
        ...completionAdmissionDriverRequest(item, `request:driver-origin:${index}`, {
          observations: [observation],
          results: [result],
        }),
        origin,
        sourceIdentity: WorkItem.projectCompletionSourceIdentity(expectation.source),
      });
      const { service } = completionAdmissionDriverService(completionWriter, {
        resultAuthorityPort: completionAdmissionDriverVerifierPort(criterion, result, [
          observation,
        ]),
      });
      const runtime = createDefaultDispatchRuntime({
        completionAdmissionService: service,
        now: () => CompletionAdmissionDriverNow,
      });
      const completionReport = completionAdmissionDriverReport(item);
      const {
        origin: projectedOrigin,
        sourceIdentity: projectedSourceIdentity,
        ...actorRequest
      } = request;
      void projectedOrigin;
      void projectedSourceIdentity;
      const outcome =
        "identity" in expectation.source
          ? await runtime.submitActorWorkItemCompletion({
              source: expectation.source,
              request: actorRequest,
              completionReport,
            })
          : await service.requestCompletion(request, completionReport);
      const stored = requiredCompletionAdmissionDriverItem(item.hash);
      const persistedAdmission = stored.completionFacts.admissions.find(
        ({ id }) => id === outcome.admission.id,
      );
      sourceReceipts.push({
        source: sourceLabel(expectation.source),
        origin,
        admissionOrigin: outcome.admission.origin,
        sourceIdentityPersisted:
          persistedAdmission !== undefined &&
          sameSourceIdentity(persistedAdmission.sourceIdentity, expectedSourceIdentity),
        boundaryTraversed: outcome.completed && outcome.admission.decision === "admit",
        terminalReceiptLinked:
          stored.completionTerminalReceipt?.admissionId === outcome.admission.id,
      });
    }
    const sourceMappingsExact = sourceReceipts.every(
      ({ origin, admissionOrigin }, index) =>
        origin === OriginExpectations[index]?.origin && admissionOrigin === origin,
    );
    const sourceIdentitiesExact = sourceReceipts.every(
      ({ sourceIdentityPersisted }) => sourceIdentityPersisted,
    );
    const allTraversedAdmissionBoundary = sourceReceipts.every(
      ({ boundaryTraversed, terminalReceiptLinked }) => boundaryTraversed && terminalReceiptLinked,
    );
    const ok = sourceMappingsExact && sourceIdentitiesExact && allTraversedAdmissionBoundary;

    return completionAdmissionScenarioReceipt(
      "all-origins",
      ok,
      "all_origins_admitted",
      "origin_admission_incomplete",
      {
        canonicalOrigins: CanonicalOrigins,
        sourceMappingsExact,
        sourceIdentitiesExact,
        allTraversedAdmissionBoundary,
        sourceReceipts,
      },
    );
  });
}

/** Persisted denormalized identity must match the projection exactly — including both absent. */
function sameSourceIdentity(
  left: WorkItem.CompletionSourceIdentity | undefined,
  right: WorkItem.CompletionSourceIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.source === right.source &&
    left.identity.kind === right.identity.kind &&
    left.identity.id === right.identity.id
  );
}

function sourceLabel(source: WorkItem.CompletionSourceOrigin): string {
  if ((source.source === "sdk" || source.source === "internal") && source.identity !== undefined) {
    return `${source.source}:${source.identity.kind}`;
  }
  return source.source;
}

// ---------------------------------------------------------------------------
// Storage scenarios
// ---------------------------------------------------------------------------

async function runStaleBasisCompletionAdmissionScenario() {
  return withCompletionAdmissionDriverStorage(async (adapter, completionWriter) => {
    const item = completionAdmissionDriverWorkItem("wi_driver_stale_basis", [
      "Current basis remains authoritative",
    ]);
    insertCompletionAdmissionDriverItem(adapter, item);
    const request = WorkItem.CompletionRequest.parse({
      ...completionAdmissionDriverRequest(item, "request:driver-stale-basis"),
      basisRef: "basis:stale-driver",
    });
    const { service, resolver } = completionAdmissionDriverService(completionWriter);
    const authorityErrorCode = await captureCompletionAdmissionDriverCode(
      resolver(item, request),
      CompletionAdmissionError,
    );
    const before = requiredCompletionAdmissionDriverItem(item.hash);
    const errorCode = await captureCompletionAdmissionDriverCode(
      service.requestCompletion(request, completionAdmissionDriverReport(item)),
      CompletionAdmissionError,
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

async function runRestartRecoveryCompletionAdmissionScenario() {
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
    let completionWriter = Storage.configure(activeAdapter);
    const item = completionAdmissionDriverWorkItem("wi_driver_restart_recovery", [
      "Recovery criterion is asserted",
    ]);
    insertCompletionAdmissionDriverItem(activeAdapter, item);
    const criterion = completionAdmissionDriverCriterion(item, 0);
    const result = completionAdmissionDriverCriterionResult(
      item,
      criterion,
      "result:driver-restart",
      {
        value: "asserted",
        assumptions: ["claimant supplied this assertion"],
        residualRisks: ["restart fixture assertion remains unverified"],
      },
    );
    const request = completionAdmissionDriverRequest(item, "request:driver-restart", {
      results: [result],
    });
    const { service } = completionAdmissionDriverService(completionWriter, {
      policyEngine: completionAdmissionDriverAssertedPolicy(criterion.id),
      stakesResolver: completionAdmissionDriverStakesResolver(),
    });
    const compareAndSet = activeAdapter.workItem.compareAndSet.bind(activeAdapter.workItem);
    let writeCount = 0;
    class SimulatedRestartError extends Error {}
    activeAdapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      writeCount += 1;
      if (writeCount === 2) throw new SimulatedRestartError("simulated restart after admission");
      return compareAndSet(hash, expectedHead, candidate);
    };
    await captureCompletionAdmissionDriverMessage(
      service.requestCompletion(request, completionAdmissionDriverReport(item)),
      "simulated restart after admission",
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
    completionWriter = Storage.configure(activeAdapter);
    const { service: resumedService } = completionAdmissionDriverService(completionWriter, {
      policyEngine: completionAdmissionDriverAssertedPolicy(criterion.id),
      stakesResolver: completionAdmissionDriverStakesResolver(),
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

async function runBypassRefusalCompletionAdmissionScenario() {
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
