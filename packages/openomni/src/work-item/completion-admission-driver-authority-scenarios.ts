import { PolicyEngine } from "@openomni/policy";
import { WorkItem } from "@openomni/protocol";
import { VerifierRegistry } from "../evidence/verifier-registry.js";
import { createCompletionAuthorityResolver } from "./completion-admission-authority.js";
import { createCompletionAdmissionService } from "./completion-admission-boundary.js";
import { completionAdmissionScenarioReceipt } from "./completion-admission-driver-contract.js";
import {
  CompletionAdmissionDriverNow,
  completionAdmissionDriverAssertedPolicy,
  completionAdmissionDriverAssertedResult,
  completionAdmissionDriverCriterion,
  completionAdmissionDriverHighStakes,
  completionAdmissionDriverProposedFacts,
  completionAdmissionDriverReport,
  completionAdmissionDriverRequest,
  completionAdmissionDriverVerifierPort,
  completionAdmissionDriverWorkItem,
  insertCompletionAdmissionDriverItem,
  requiredCompletionAdmissionDriverItem,
  withCompletionAdmissionDriverStorage,
} from "./completion-admission-driver-fixtures.js";
import { evaluateCompletion } from "./completion-admission-fold.js";

export async function runKnownBadCompletionAdmissionScenario() {
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
    const observation: WorkItem.Observation = {
      id: "observation:driver-known-bad",
      producer: verification.verifierId,
      subjectRef: item.hash,
      basisRef: item.completionContract.basisRef,
      artifactRefs: [],
      provenanceRef: verification.basisHash,
      ancestryRefs: [],
      observedAt: CompletionAdmissionDriverNow,
    };
    const result = WorkItem.CriterionResult.parse({
      id: "result:driver-known-bad",
      criterionId: criterion.id,
      value: "refuted",
      checkedPredicate,
      observationIds: [observation.id],
      verifierRef: verification.verifierId,
      assumptions: [],
      basisRef: item.completionContract.basisRef,
      residualRisks: [],
      createdAt: CompletionAdmissionDriverNow,
    });
    const request = completionAdmissionDriverRequest(item, "request:driver-known-bad", {
      observations: [observation],
      results: [result],
    });
    const foldAdmission = evaluateCompletion({
      admissionId: "admission:driver-known-bad:fold",
      requestId: request.id,
      requestSnapshot: request,
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
    const resolver = createCompletionAuthorityResolver({
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: completionAdmissionDriverVerifierPort(criterion, result, [observation]),
      now: () => CompletionAdmissionDriverNow,
    });
    const service = createCompletionAdmissionService({
      completionWriter,
      authorityResolver: resolver,
      now: () => CompletionAdmissionDriverNow,
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

export async function runAssertedCompletionAdmissionScenario() {
  const lowItem = completionAdmissionDriverWorkItem("wi_driver_low_asserted", [
    "Low-risk criterion is claimed",
  ]);
  const lowCriterion = completionAdmissionDriverCriterion(lowItem, 0);
  const lowRisk = "claimant assertion remains independently unverified";
  const lowResult = completionAdmissionDriverAssertedResult(
    lowItem,
    lowCriterion,
    "result:driver-low",
    [lowRisk],
  );
  const lowRequest = completionAdmissionDriverRequest(lowItem, "request:driver-low", {
    results: [lowResult],
  });
  const withoutPolicy = await createCompletionAuthorityResolver({
    policyEngine: PolicyEngine.create(),
    now: () => CompletionAdmissionDriverNow,
  }).resolve(lowItem, lowRequest);
  const withPolicy = await createCompletionAuthorityResolver({
    policyEngine: completionAdmissionDriverAssertedPolicy(lowCriterion.id),
    now: () => CompletionAdmissionDriverNow,
  }).resolve(lowItem, lowRequest);

  const highItem = completionAdmissionDriverWorkItem("wi_driver_high_asserted", [
    "High-stakes criterion is claimed",
  ]);
  const highCriterion = completionAdmissionDriverCriterion(highItem, 0);
  const highResult = completionAdmissionDriverAssertedResult(
    highItem,
    highCriterion,
    "result:driver-high",
    ["high-stakes assertion has no independent verification"],
  );
  const highRequest = completionAdmissionDriverRequest(highItem, "request:driver-high", {
    results: [highResult],
  });
  const stakes = completionAdmissionDriverHighStakes();
  const highAdmission = await createCompletionAuthorityResolver({
    policyEngine: PolicyEngine.create(),
    stakesResolver: {
      resolve(subject) {
        return {
          ok: true,
          context: {
            surface: "work.complete.pre",
            workItemHash: subject.workItemHash,
            requestId: subject.requestId,
            contractRevision: subject.contractRevision,
            basisRef: subject.basisRef,
            expectedHead: subject.expectedHead,
            stakes,
          },
        };
      },
    },
    now: () => CompletionAdmissionDriverNow,
  }).resolve(highItem, highRequest);
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
