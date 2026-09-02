// allow: SIZE_OK — one completion-admission state machine owns selection, durable admission, and terminal linkage.
import { newTraceId } from "@openomni/telemetry";
import type { Storage } from "@openomni/ledger";
import { WorkItemStore } from "@openomni/ledger";
import { WorkItem } from "@openomni/protocol";
import { validateCompletionTerminalLinkage } from "./terminal-linkage";

/**
 * Resident-side completion admission (kernel-contract completion law): a
 * WorkItem completes only through an admitted judgment over its acceptance
 * criteria. Worker reports are Evidence; only VERIFIED criterion results
 * admit. Anything less — asserted, refuted, missing — records a durable
 * block admission and refuses.
 */
export type CompletionJudgment =
  | Readonly<{ criterionId: string; value: "asserted" }>
  | Readonly<{
      criterionId: string;
      value: "verified" | "refuted";
      /** What was actually checked — the predicate the Resident exercised. */
      checkedPredicate: string;
      /** Evidence already on the WorkItem that the check consumed. */
      evidenceIds: readonly string[];
    }>
  | Readonly<{
      criterionId: string;
      value: "recorded";
      /** A durable verifier-produced `verified` result selected by id. */
      resultId: string;
    }>;

type CompletionOutcome =
  | Readonly<{ admitted: true; workItemId: string }>
  | Readonly<{ admitted: false; reason: string }>;

interface WorkItemSummary {
  readonly workItemId: string;
  readonly name: string;
  readonly status: WorkItem.Status;
  readonly criteria: ReadonlyArray<Readonly<{ id: string; statement: string; required: boolean }>>;
  readonly evidence: ReadonlyArray<
    Readonly<{ id: string; kind: string; description: string; passed: boolean; detail?: string }>
  >;
  readonly recordedResults: ReadonlyArray<
    Readonly<{
      id: string;
      criterionId: string;
      value: WorkItem.ResultValue;
      verifierRef: string;
      basisRef: string;
      invalidated: boolean;
    }>
  >;
  readonly attemptOutcome?: WorkItem.AttemptOutcome;
}

export interface CompletionPort {
  list(): WorkItemSummary[];
  inspect(workItemId: string): WorkItemSummary | undefined;
  complete(input: {
    workItemId: string;
    judgments: readonly CompletionJudgment[];
  }): Promise<CompletionOutcome>;
}

export interface CompletionPortOptions {
  readonly writer: Storage.WorkItemCompletionWriter;
  readonly now: () => number;
}

const POLICY_REF = "policy:resident-completion-v1";

function linkageRefusal(path: readonly PropertyKey[] | undefined): string {
  const location = path?.join(".") || "terminal";
  return `completion linkage rejected at ${location}`;
}

function summarize(item: WorkItem.Info): WorkItemSummary {
  const invalidated = new Set(
    item.completionFacts.invalidations.map((invalidation) => invalidation.resultId),
  );
  return {
    workItemId: item.workItemId,
    name: item.name,
    status: WorkItem.deriveStatus(item),
    criteria: item.completionFacts.criteria.map(({ id, statement, required }) => ({
      id,
      statement,
      required,
    })),
    evidence: item.evidence.map(({ id, kind, description, passed, detail }) => ({
      id,
      kind,
      description,
      passed,
      ...(detail === undefined ? {} : { detail }),
    })),
    recordedResults: item.completionFacts.results.flatMap(
      ({ id, criterionId, value, verifierRef, basisRef }) =>
        verifierRef === undefined
          ? []
          : [{ id, criterionId, value, verifierRef, basisRef, invalidated: invalidated.has(id) }],
    ),
    ...(item.attemptTerminal === undefined ? {} : { attemptOutcome: item.attemptTerminal.outcome }),
  };
}

interface CompletionInput {
  readonly workItemId: string;
  readonly judgments: readonly CompletionJudgment[];
}

type VerifierRecordedResult = WorkItem.CriterionResult &
  Readonly<{
    value: "verified";
    verifierRef: string;
    checkedPredicate: string;
  }>;

type ResolvedCompletionJudgment =
  | Exclude<CompletionJudgment, Readonly<{ value: "recorded" }>>
  | Readonly<{
      criterionId: string;
      value: "recorded";
      result: VerifierRecordedResult;
    }>;

interface ResolvedCompletionInput {
  readonly workItemId: string;
  readonly judgments: readonly ResolvedCompletionJudgment[];
}

type RecordedResolution =
  | Readonly<{ ok: true; input: ResolvedCompletionInput }>
  | Readonly<{ ok: false; reason: string }>;

function assertNever(value: never): never {
  throw new TypeError(`unreachable completion judgment: ${JSON.stringify(value)}`);
}

interface CompletionFacts {
  readonly observations: WorkItem.Observation[];
  readonly results: WorkItem.CriterionResult[];
  readonly claims: WorkItem.Claim[];
}

interface CompletionDecision {
  readonly admit: boolean;
  readonly verifiedCriterionIds: ReadonlySet<string>;
  readonly refutedCriterionIds: readonly string[];
  readonly unresolved: readonly string[];
}

function refuse(reason: string): CompletionOutcome {
  return { admitted: false, reason };
}

function completionStateRefusal(current: WorkItem.Info, workItemId: string): string | undefined {
  const status = WorkItem.deriveStatus(current);
  if (status === "completed" || status === "cancelled") {
    return `WorkItem ${workItemId} is already ${status}`;
  }
  if (status === "failed") {
    // A failed item outranks a completed timestamp in deriveStatus, so a
    // receipt written here could never surface as completed. Failed-item
    // retry is a target contract, not a currently implemented product path.
    return `WorkItem ${workItemId} is failed; failed-item retry is not implemented`;
  }
  return undefined;
}

function judgmentCriteriaRefusal(
  input: CompletionInput,
  criteria: ReadonlyMap<string, WorkItem.Criterion>,
): string | undefined {
  const seen = new Set<string>();
  for (const judgment of input.judgments) {
    if (!criteria.has(judgment.criterionId)) {
      return `judgment targets an unknown criterion: ${judgment.criterionId}`;
    }
    if (seen.has(judgment.criterionId)) {
      return `duplicate judgment for criterion: ${judgment.criterionId}`;
    }
    seen.add(judgment.criterionId);
  }
  return undefined;
}

function resolveRecordedJudgments(
  input: CompletionInput,
  current: WorkItem.Info,
): RecordedResolution {
  const results = new Map(current.completionFacts.results.map((result) => [result.id, result]));
  const invalidated = new Set(
    current.completionFacts.invalidations.map((invalidation) => invalidation.resultId),
  );
  const judgments: ResolvedCompletionJudgment[] = [];
  for (const judgment of input.judgments) {
    switch (judgment.value) {
      case "asserted":
      case "verified":
      case "refuted":
        judgments.push(judgment);
        break;
      case "recorded": {
        const result = results.get(judgment.resultId);
        if (result === undefined) {
          return { ok: false, reason: `recorded result was not recorded: ${judgment.resultId}` };
        }
        if (result.value !== "verified") {
          return { ok: false, reason: `recorded result is not verified: ${judgment.resultId}` };
        }
        if (result.criterionId !== judgment.criterionId) {
          return {
            ok: false,
            reason: `recorded result ${judgment.resultId} belongs to criterion ${result.criterionId}`,
          };
        }
        if (result.basisRef !== current.completionContract.basisRef) {
          return {
            ok: false,
            reason: `recorded result ${judgment.resultId} does not match the current basis`,
          };
        }
        if (result.verifierRef === undefined) {
          return {
            ok: false,
            reason: `recorded result ${judgment.resultId} has no verifier reference`,
          };
        }
        if (invalidated.has(result.id)) {
          return { ok: false, reason: `recorded result was invalidated: ${judgment.resultId}` };
        }
        judgments.push({
          criterionId: judgment.criterionId,
          value: "recorded",
          result: { ...result, value: "verified", verifierRef: result.verifierRef },
        });
        break;
      }
      default:
        assertNever(judgment);
    }
  }
  return { ok: true, input: { workItemId: input.workItemId, judgments } };
}

function judgmentEvidenceRefusal(
  input: CompletionInput,
  current: WorkItem.Info,
): string | undefined {
  const evidenceIds = new Set(current.evidence.map(({ id }) => id));
  for (const judgment of input.judgments) {
    switch (judgment.value) {
      case "asserted":
      case "recorded":
        break;
      case "verified":
      case "refuted": {
        if (judgment.evidenceIds.length === 0) {
          return `a ${judgment.value} judgment consumes at least one piece of evidence`;
        }
        const missing = judgment.evidenceIds.find((id) => !evidenceIds.has(id));
        if (missing !== undefined) {
          return `judgment references evidence not on the WorkItem: ${missing}`;
        }
        break;
      }
      default:
        assertNever(judgment);
    }
  }
  return undefined;
}

function buildCompletionFacts(
  input: ResolvedCompletionInput,
  base: WorkItem.Info,
  criteria: ReadonlyMap<string, WorkItem.Criterion>,
  verificationEvidence: ReadonlyMap<string, string>,
  now: number,
): CompletionFacts {
  const basisRef = base.completionContract.basisRef;
  const nextFactsRevision = base.completionFacts.revision + 1;
  const observations: WorkItem.Observation[] = [];
  const results: WorkItem.CriterionResult[] = [];
  const claims: WorkItem.Claim[] = [];
  for (const [index, judgment] of input.judgments.entries()) {
    switch (judgment.value) {
      case "asserted":
        results.push(
          WorkItem.CriterionResult.parse({
            id: `result:${input.workItemId}:${nextFactsRevision}:${index}`,
            criterionId: judgment.criterionId,
            observationIds: [],
            value: "asserted",
            assumptions: [],
            residualRisks: [],
            basisRef,
            createdAt: now,
          }),
        );
        break;
      case "recorded":
        claims.push(
          WorkItem.Claim.parse({
            id: `claim:${input.workItemId}:${nextFactsRevision}:${index}`,
            criterionId: judgment.criterionId,
            statement: criteria.get(judgment.criterionId)?.statement ?? judgment.criterionId,
            observationIds: judgment.result.observationIds,
            basisRef,
            createdAt: now,
          }),
        );
        break;
      case "verified":
      case "refuted": {
        const verificationId = verificationEvidence.get(judgment.criterionId);
        const observation = WorkItem.Observation.parse({
          id: `observation:${input.workItemId}:${nextFactsRevision}:${index}`,
          producer: "resident-completion",
          subjectRef: input.workItemId,
          basisRef,
          artifactRefs:
            verificationId === undefined
              ? [...judgment.evidenceIds]
              : [verificationId, ...judgment.evidenceIds],
          provenanceRef: verificationId ?? judgment.evidenceIds[0],
          ancestryRefs: [],
          observedAt: now,
        });
        observations.push(observation);
        if (judgment.value === "verified") {
          claims.push(
            WorkItem.Claim.parse({
              id: `claim:${input.workItemId}:${nextFactsRevision}:${index}`,
              criterionId: judgment.criterionId,
              statement: criteria.get(judgment.criterionId)?.statement ?? judgment.criterionId,
              observationIds: [observation.id],
              basisRef,
              createdAt: now,
            }),
          );
        }
        results.push(
          WorkItem.CriterionResult.parse({
            id: `result:${input.workItemId}:${nextFactsRevision}:${index}`,
            criterionId: judgment.criterionId,
            observationIds: [observation.id],
            value: judgment.value,
            checkedPredicate: judgment.checkedPredicate,
            assumptions: [],
            residualRisks: [],
            basisRef,
            createdAt: now,
          }),
        );
        break;
      }
      default:
        assertNever(judgment);
    }
  }
  return { observations, results, claims };
}

function recordedResults(
  judgments: readonly ResolvedCompletionJudgment[],
): readonly VerifierRecordedResult[] {
  return judgments.flatMap((judgment) => {
    switch (judgment.value) {
      case "asserted":
      case "verified":
      case "refuted":
        return [];
      case "recorded":
        return [judgment.result];
      default:
        return assertNever(judgment);
    }
  });
}

function decideCompletion(
  base: WorkItem.Info,
  results: readonly WorkItem.CriterionResult[],
  judgments: readonly ResolvedCompletionJudgment[],
): CompletionDecision {
  const verifiedCriterionIds = new Set([
    ...results.filter(({ value }) => value === "verified").map(({ criterionId }) => criterionId),
    ...recordedResults(judgments).map(({ criterionId }) => criterionId),
  ]);
  const refutedCriterionIds = results
    .filter(({ value }) => value === "refuted")
    .map(({ criterionId }) => criterionId);
  const unresolved = base.completionFacts.criteria
    .filter(({ id, required }) => required && !verifiedCriterionIds.has(id))
    .map(({ id }) => id);
  return {
    admit: unresolved.length === 0 && refutedCriterionIds.length === 0,
    verifiedCriterionIds,
    refutedCriterionIds,
    unresolved,
  };
}

function buildCompletionReport(
  input: ResolvedCompletionInput,
  base: WorkItem.Info,
  criteria: ReadonlyMap<string, WorkItem.Criterion>,
  verificationEvidence: ReadonlyMap<string, string>,
  decision: CompletionDecision,
): WorkItem.CompletionReport | undefined {
  if (!decision.admit) return undefined;
  const observations = new Map(
    base.completionFacts.observations.map((observation) => [observation.id, observation]),
  );
  return WorkItem.canonicalCompletionReport(
    WorkItem.CompletionReport.parse({
      summary: `Resident verified ${decision.verifiedCriterionIds.size} acceptance criteria for ${base.name}`,
      claims: input.judgments.flatMap((judgment) => {
        switch (judgment.value) {
          case "asserted":
          case "refuted":
            return [];
          case "verified": {
            const verificationId = verificationEvidence.get(judgment.criterionId);
            return verificationId === undefined
              ? []
              : [
                  {
                    statement:
                      criteria.get(judgment.criterionId)?.statement ?? judgment.criterionId,
                    evidenceIds: [verificationId],
                  },
                ];
          }
          case "recorded":
            return [
              {
                statement: criteria.get(judgment.criterionId)?.statement ?? judgment.criterionId,
                evidenceIds: judgment.result.observationIds.flatMap(
                  (observationId) => observations.get(observationId)?.artifactRefs ?? [],
                ),
              },
            ];
          default:
            return assertNever(judgment);
        }
      }),
    }),
  );
}

function buildAdmission(
  input: ResolvedCompletionInput,
  base: WorkItem.Info,
  facts: CompletionFacts,
  decision: CompletionDecision,
  report: WorkItem.CompletionReport | undefined,
  reportRef: string | undefined,
  now: number,
): WorkItem.CompletionAdmission {
  const requestId = `completion-request:${input.workItemId}:${base.revision}:resident`;
  const effectiveResultIds = [
    ...facts.results.filter(({ value }) => value === "verified").map(({ id }) => id),
    ...recordedResults(input.judgments).map(({ id }) => id),
  ];
  const consumesRecordedResults = input.judgments.some((judgment) => judgment.value === "recorded");
  return WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${input.workItemId}:${base.revision + 1}:resident`,
    requestId,
    workItemHash: input.workItemId,
    origin: "resident",
    contractRevision: base.completionContract.revision,
    basisRef: base.completionContract.basisRef,
    requestRoot: `request-root:${input.workItemId}:${base.revision}`,
    proposedFactIds: {
      claims: facts.claims.map(({ id }) => id),
      observations: facts.observations.map(({ id }) => id),
      results: facts.results.map(({ id }) => id),
      invalidations: [],
      verificationErrors: [],
      effects: [],
    },
    effectiveResultIds,
    unresolvedCriterionIds: decision.admit ? [] : decision.unresolved,
    decision: decision.admit ? "admit" : "block",
    reasonCodes: [
      ...(decision.admit
        ? ["resident_verified_all_required"]
        : [
            ...(decision.unresolved.length > 0 ? ["unverified_required_criteria"] : []),
            ...(decision.refutedCriterionIds.length > 0 ? ["refuted_criteria"] : []),
          ]),
      ...(consumesRecordedResults ? ["verifier_recorded_results"] : []),
    ],
    residualRisks: [],
    policyRef: POLICY_REF,
    ...(report === undefined
      ? {}
      : { completionReportSnapshot: report, completionReportRef: reportRef }),
    expectedHead: base.revision,
    recordedHead: base.revision + 1,
    createdAt: now,
  });
}

function recordAdmissionCandidate(
  base: WorkItem.Info,
  facts: CompletionFacts,
  admission: WorkItem.CompletionAdmission,
  now: number,
): WorkItem.Info {
  return WorkItem.Info.parse({
    ...base,
    revision: admission.recordedHead,
    completionFacts: {
      ...base.completionFacts,
      revision: base.completionFacts.revision + 1,
      claims: [...base.completionFacts.claims, ...facts.claims],
      observations: [...base.completionFacts.observations, ...facts.observations],
      results: [...base.completionFacts.results, ...facts.results],
      admissions: [...base.completionFacts.admissions, admission],
    },
    timestamps: { ...base.timestamps, updated: now },
  });
}

function blockedCompletionReason(decision: CompletionDecision): string {
  const why = [
    ...(decision.unresolved.length > 0
      ? [`required criteria without a verified result: ${decision.unresolved.join(", ")}`]
      : []),
    ...(decision.refutedCriterionIds.length > 0
      ? [`refuted criteria: ${decision.refutedCriterionIds.join(", ")}`]
      : []),
  ].join("; ");
  return `completion blocked — ${why}. Only verified results admit.`;
}

function completeAdmissionCandidate(
  input: ResolvedCompletionInput,
  recorded: WorkItem.Info,
  admission: WorkItem.CompletionAdmission,
  report: WorkItem.CompletionReport | undefined,
  reportRef: string | undefined,
  now: number,
): WorkItem.Info {
  const receipt: WorkItem.CompletionTerminalReceipt = {
    version: 1,
    hash: input.workItemId,
    requestId: admission.requestId,
    admissionId: admission.id,
    contractRevision: admission.contractRevision,
    basisRef: admission.basisRef,
    ...(reportRef === undefined ? {} : { completionReportRef: reportRef }),
    recordedHead: recorded.revision + 1,
  };
  const completedAt = now + 1;
  return WorkItem.Info.parse({
    ...recorded,
    revision: recorded.revision + 1,
    ...(report === undefined ? {} : { completionReport: report }),
    completionTerminalReceipt: receipt,
    timestamps: { ...recorded.timestamps, completed: completedAt, updated: completedAt },
  });
}

type FinalizeOutcome = CompletionOutcome | "admission_race" | "receipt_race";

async function finalize(
  input: ResolvedCompletionInput,
  base: WorkItem.Info,
  criteria: ReadonlyMap<string, WorkItem.Criterion>,
  verificationEvidence: ReadonlyMap<string, string>,
  options: CompletionPortOptions,
): Promise<FinalizeOutcome> {
  const now = options.now();
  const facts = buildCompletionFacts(input, base, criteria, verificationEvidence, now);
  const decision = decideCompletion(base, facts.results, input.judgments);
  const report = buildCompletionReport(input, base, criteria, verificationEvidence, decision);
  const reportRef = report === undefined ? undefined : WorkItem.completionReportReference(report);
  const admission = buildAdmission(input, base, facts, decision, report, reportRef, now);
  const recorded = recordAdmissionCandidate(base, facts, admission, now);
  const recordedLinkage = validateCompletionTerminalLinkage(recorded);
  if (!recordedLinkage.success) {
    return refuse(linkageRefusal(recordedLinkage.error.issues[0]?.path));
  }
  if (!options.writer(input.workItemId, base.revision, recorded)) return "admission_race";
  if (!decision.admit) return refuse(blockedCompletionReason(decision));

  const completed = completeAdmissionCandidate(input, recorded, admission, report, reportRef, now);
  const completedLinkage = validateCompletionTerminalLinkage(completed);
  if (!completedLinkage.success) {
    return refuse(linkageRefusal(completedLinkage.error.issues[0]?.path));
  }
  if (!options.writer(input.workItemId, recorded.revision, completed)) return "receipt_race";
  return { admitted: true, workItemId: input.workItemId };
}

export function createCompletionPort(options: CompletionPortOptions): CompletionPort {
  async function complete(input: CompletionInput): Promise<CompletionOutcome> {
    const current = WorkItemStore.get(input.workItemId);
    if (current === undefined) return refuse(`unknown WorkItem: ${input.workItemId}`);

    const stateRefusal = completionStateRefusal(current, input.workItemId);
    if (stateRefusal !== undefined) return refuse(stateRefusal);

    const criteria = new Map(
      current.completionFacts.criteria.map((criterion) => [criterion.id, criterion]),
    );
    const criteriaRefusal = judgmentCriteriaRefusal(input, criteria);
    if (criteriaRefusal !== undefined) return refuse(criteriaRefusal);
    const evidenceRefusal = judgmentEvidenceRefusal(input, current);
    if (evidenceRefusal !== undefined) return refuse(evidenceRefusal);
    const recordedResolution = resolveRecordedJudgments(input, current);
    if (!recordedResolution.ok) return refuse(recordedResolution.reason);

    // Verification writes remain sequential: each durable evidence record is
    // completed before the next is attempted and before terminal admission.
    const verificationRevision = current.completionFacts.revision + 1;
    const verificationEvidence = new Map<string, string>();
    for (const [index, judgment] of input.judgments.entries()) {
      if (judgment.value !== "verified") continue;
      const verificationId = `evidence:verification:${input.workItemId}:${verificationRevision}:${index}`;
      const written = await WorkItemStore.addEvidence(
        input.workItemId,
        {
          id: verificationId,
          kind: "custom",
          description: `resident verification: ${judgment.checkedPredicate}`,
          passed: true,
          detail: `checked evidence: ${judgment.evidenceIds.join(", ")}`,
        },
        newTraceId(),
      );
      if (written === undefined) {
        return refuse(`WorkItem vanished while recording verification: ${input.workItemId}`);
      }
      verificationEvidence.set(judgment.criterionId, verificationId);
    }

    // Terminal linkage requires the receipt to immediately follow its
    // admission head, so a lost head race is never patched in place.
    let admissionRecorded = false;
    for (let round = 0; round < 2; round += 1) {
      const settledLate = WorkItemStore.get(input.workItemId);
      if (settledLate?.completionTerminalReceipt !== undefined) {
        const linkage = validateCompletionTerminalLinkage(settledLate);
        return linkage.success
          ? { admitted: true, workItemId: input.workItemId }
          : refuse(linkageRefusal(linkage.error.issues[0]?.path));
      }
      const base = settledLate ?? current;
      const latestResolution = resolveRecordedJudgments(input, base);
      if (!latestResolution.ok) return refuse(latestResolution.reason);
      const outcome = await finalize(
        latestResolution.input,
        base,
        criteria,
        verificationEvidence,
        options,
      );
      if (outcome === "admission_race") continue;
      if (outcome === "receipt_race") {
        admissionRecorded = true;
        continue;
      }
      return outcome;
    }
    return refuse(
      admissionRecorded
        ? `terminal receipt write kept losing the head race for ${input.workItemId}; the admission is recorded — re-run complete_work to finish`
        : `completion admission write kept losing the head race for ${input.workItemId}`,
    );
  }

  return {
    list: () => WorkItemStore.list().map(summarize),
    inspect: (workItemId) => {
      const item = WorkItemStore.get(workItemId);
      return item === undefined ? undefined : summarize(item);
    },
    complete,
  };
}
