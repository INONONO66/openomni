import { PolicyEngine } from "@openomni/policy";
import { WorkItem } from "@openomni/protocol";
import { createCompletionAuthorityResolver } from "./completion-admission-authority.js";
import { createCompletionAdmissionService } from "./completion-admission-boundary.js";
import { completionAdmissionScenarioReceipt } from "./completion-admission-driver-contract.js";
import {
  CompletionAdmissionDriverNow,
  completionAdmissionDriverCriterion,
  completionAdmissionDriverReport,
  completionAdmissionDriverRequest,
  completionAdmissionDriverVerifierPort,
  completionAdmissionDriverWorkItem,
  insertCompletionAdmissionDriverItem,
  requiredCompletionAdmissionDriverItem,
  withCompletionAdmissionDriverStorage,
} from "./completion-admission-driver-fixtures.js";
import { type CompletionSourceOrigin, projectCompletionOrigin } from "./completion-origin.js";

type OriginExpectation = Readonly<{
  source: CompletionSourceOrigin;
  origin: WorkItem.CompletionOrigin;
}>;

type OriginAdmissionReceipt = Readonly<{
  source: string;
  origin: WorkItem.CompletionOrigin;
  admissionOrigin: WorkItem.CompletionOrigin;
  boundaryTraversed: boolean;
  terminalReceiptLinked: boolean;
}>;

const OriginExpectations = [
  { source: { source: "resident" }, origin: "resident" },
  { source: { source: "internal_worker" }, origin: "worker" },
  { source: { source: "connector_worker" }, origin: "worker" },
  { source: { source: "api" }, origin: "external_actor" },
  { source: { source: "a2a" }, origin: "external_actor" },
  { source: { source: "human" }, origin: "external_actor" },
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
  project: typeof projectCompletionOrigin = projectCompletionOrigin,
) {
  return withCompletionAdmissionDriverStorage(async (adapter) => {
    const sourceReceipts: OriginAdmissionReceipt[] = [];
    for (const [index, expectation] of OriginExpectations.entries()) {
      const origin = project(expectation.source);
      const item = completionAdmissionDriverWorkItem(`wi_driver_origin_${index}`, [
        `Origin ${index} traverses admission`,
      ]);
      insertCompletionAdmissionDriverItem(adapter, item);
      const criterion = completionAdmissionDriverCriterion(item, 0);
      const observation: WorkItem.Observation = {
        id: `observation:driver-origin:${index}`,
        producer: "verifier:driver-origin",
        subjectRef: item.hash,
        basisRef: item.completionContract.basisRef,
        artifactRefs: [`evidence:${item.hash}:report`],
        ancestryRefs: [],
        observedAt: CompletionAdmissionDriverNow,
      };
      const result = WorkItem.CriterionResult.parse({
        id: `result:driver-origin:${index}`,
        criterionId: criterion.id,
        value: "verified",
        checkedPredicate: criterion.statement,
        observationIds: [observation.id],
        verifierRef: "verifier:driver-origin",
        assumptions: [],
        basisRef: item.completionContract.basisRef,
        residualRisks: [],
        createdAt: CompletionAdmissionDriverNow,
      });
      const request = WorkItem.CompletionRequest.parse({
        ...completionAdmissionDriverRequest(item, `request:driver-origin:${index}`, {
          observations: [observation],
          results: [result],
        }),
        origin,
      });
      const service = createCompletionAdmissionService({
        authorityResolver: createCompletionAuthorityResolver({
          policyEngine: PolicyEngine.create(),
          resultAuthorityPort: completionAdmissionDriverVerifierPort(criterion, result, [
            observation,
          ]),
          now: () => CompletionAdmissionDriverNow,
        }),
        now: () => CompletionAdmissionDriverNow,
      });
      const outcome = await service.requestCompletion(
        request,
        completionAdmissionDriverReport(item),
      );
      const stored = requiredCompletionAdmissionDriverItem(item.hash);
      sourceReceipts.push({
        source: sourceLabel(expectation.source),
        origin,
        admissionOrigin: outcome.admission.origin,
        boundaryTraversed: outcome.completed && outcome.admission.decision === "admit",
        terminalReceiptLinked:
          stored.completionTerminalReceipt?.admissionId === outcome.admission.id,
      });
    }
    const sourceMappingsExact = sourceReceipts.every(
      ({ origin, admissionOrigin }, index) =>
        origin === OriginExpectations[index]?.origin && admissionOrigin === origin,
    );
    const allTraversedAdmissionBoundary = sourceReceipts.every(
      ({ boundaryTraversed, terminalReceiptLinked }) => boundaryTraversed && terminalReceiptLinked,
    );
    const ok = sourceMappingsExact && allTraversedAdmissionBoundary;

    return completionAdmissionScenarioReceipt(
      "all-origins",
      ok,
      "all_origins_admitted",
      "origin_admission_incomplete",
      {
        canonicalOrigins: CanonicalOrigins,
        sourceMappingsExact,
        allTraversedAdmissionBoundary,
        sourceReceipts,
      },
    );
  });
}

function sourceLabel(source: CompletionSourceOrigin): string {
  if (source.source === "sdk" || source.source === "internal") {
    return `${source.source}:${source.identity.kind}`;
  }
  return source.source;
}
