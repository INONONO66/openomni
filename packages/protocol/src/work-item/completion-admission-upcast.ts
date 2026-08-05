import { z } from "zod";
import {
  canonicalCompletionReport,
  CompletionReport,
  completionReportReference,
} from "./completion-admission.js";
import { criterionId, stableToken } from "./hash.js";
import type {
  Claim,
  CompletionAdmission,
  CompletionContract,
  CompletionFacts,
  Criterion,
  CriterionResult,
  Observation,
} from "./completion-admission.js";

const LegacyEvidence = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    passed: z.boolean(),
    createdAt: z.number().finite(),
  })
  .passthrough();

const LegacyCompletionReport = z
  .object({
    claims: z.array(
      z.object({
        statement: z.string().min(1),
        evidenceIds: z.array(z.string().min(1)),
      }),
    ),
  })
  .passthrough();
type LegacyReport = z.infer<typeof LegacyCompletionReport>["claims"][number];

const LegacyWorkItem = z
  .object({
    hash: z.string().min(1),
    name: z.string(),
    goal: z.string(),
    acceptanceCriteria: z.array(z.string()).default([]),
    timestamps: z.object({ completed: z.number().finite().optional() }).passthrough(),
    evidence: z.array(LegacyEvidence).default([]),
    completionReport: LegacyCompletionReport.optional(),
  })
  .passthrough();

export function upcastLegacyCompletion(input: unknown): unknown {
  if (!isLegacyCompletionRow(input)) return input;
  const parsed = LegacyWorkItem.safeParse(input);
  if (!parsed.success) return input;
  const persistedCompletionReports = (parsed.data.completionReport?.claims ?? []).map(
    (report, index) => ({
      ...report,
      statement: legacyReportStatement(report.statement, index),
    }),
  );

  const contract: CompletionContract = {
    version: 1,
    revision: "legacy-v1",
    basisRef: "legacy-basis",
  };
  const acceptanceCriteria = legacyAcceptanceCriteria(parsed.data, persistedCompletionReports);
  const completedAt = parsed.data.timestamps.completed;
  const needsArchiveReport =
    completedAt !== undefined && parsed.data.completionReport === undefined;
  const archiveEvidenceId = `evidence:${parsed.data.hash}:legacy-completion-archive`;
  const completionReports = needsArchiveReport
    ? acceptanceCriteria.map((statement) => ({
        statement,
        evidenceIds: [archiveEvidenceId],
      }))
    : persistedCompletionReports;
  const normalizedCompletionReport = parsed.data.completionReport
    ? { ...parsed.data.completionReport, claims: completionReports }
    : needsArchiveReport
      ? {
          summary: "Archived historical completion without a persisted report.",
          claims: completionReports,
          caveats: ["the historical completion report was not persisted"],
          followUps: [],
        }
      : undefined;
  const criteria = legacyCriteria(parsed.data.hash, acceptanceCriteria);
  const persistedEvidence = needsArchiveReport
    ? [
        ...parsed.data.evidence,
        {
          id: archiveEvidenceId,
          kind: "custom" as const,
          description: "Historical completion archive marker",
          passed: true,
          detail: "generated while decoding a completed legacy row without a completion report",
          createdAt: completedAt,
        },
      ]
    : parsed.data.evidence;
  const evidenceIds = new Set<string>();
  for (const { id } of persistedEvidence) {
    if (evidenceIds.has(id)) throw new Error(`duplicate legacy evidence id: ${id}`);
    evidenceIds.add(id);
  }
  const observationsByEvidenceId = legacyObservations(parsed.data.hash, persistedEvidence);
  const claims = legacyClaims(
    parsed.data.hash,
    contract.basisRef,
    criteria,
    completionReports,
    observationsByEvidenceId,
  );
  const observations = [...observationsByEvidenceId.values()].map(({ observation }) => observation);
  const directResults = legacyResults(
    parsed.data.hash,
    contract.basisRef,
    claims,
    observationsByEvidenceId,
  );
  const parsedCompletionReport = CompletionReport.safeParse(normalizedCompletionReport);
  const completionReport = parsedCompletionReport.success
    ? canonicalCompletionReport(parsedCompletionReport.data)
    : undefined;
  if (parsed.data.timestamps.completed !== undefined) {
    const resultCriterionIds = new Set(directResults.map(({ criterionId }) => criterionId));
    const unresolvedClaimCriterionIds = claims
      .filter(({ criterionId }) => !resultCriterionIds.has(criterionId))
      .map(({ criterionId }) => criterionId);
    if (unresolvedClaimCriterionIds.length > 0) {
      throw new Error(
        `completed legacy WorkItem lacks passed evidence for report claims: ${unresolvedClaimCriterionIds.join(", ")}`,
      );
    }
  }
  const archiveOverrideCriterionIds =
    parsed.data.timestamps.completed === undefined
      ? []
      : legacyUnresolvedCriterionIds(criteria, directResults);
  const results = [
    ...directResults,
    ...legacyArchiveOverrideResults(
      parsed.data.hash,
      contract.basisRef,
      archiveOverrideCriterionIds,
      claims,
      parsed.data.timestamps.completed,
    ),
  ];
  if (completedAt !== undefined && completionReport === undefined) {
    throw new Error("completed legacy WorkItem requires a valid completion report");
  }
  const admissions = legacyAdmissions(
    parsed.data.hash,
    contract,
    parsed.data.timestamps.completed,
    archiveOverrideCriterionIds.length > 0,
    {
      claims,
      observations,
      results,
    },
    completionReport,
  );
  const facts: CompletionFacts = {
    version: 1,
    revision: admissions.length,
    criteria,
    claims,
    observations,
    results,
    invalidations: [],
    verificationErrors: [],
    effects: [],
    requestReservations: [],
    admissions,
  };

  const admission = admissions[0];
  const recordedHead = admission ? admission.recordedHead + 1 : 0;
  const completionTerminalReceipt = admission
    ? {
        version: 1 as const,
        hash: parsed.data.hash,
        requestId: admission.requestId,
        admissionId: admission.id,
        contractRevision: admission.contractRevision,
        basisRef: admission.basisRef,
        completionReportRef: admission.completionReportRef,
        recordedHead,
      }
    : undefined;

  return {
    ...parsed.data,
    revision: recordedHead,
    evidence: persistedEvidence,
    acceptanceCriteria,
    completionContract: contract,
    completionFacts: facts,
    completionReport,
    completionTerminalReceipt,
  };
}

function legacyAcceptanceCriteria(
  parsed: z.infer<typeof LegacyWorkItem>,
  reports: readonly LegacyReport[],
): string[] {
  const acceptanceCriteria = parsed.acceptanceCriteria.filter(
    (statement) => statement.trim().length > 0,
  );
  if (acceptanceCriteria.length === 0 && reports.length === 0) {
    const fallback = [parsed.goal, parsed.name, parsed.hash].find(
      (statement) => statement.trim().length > 0,
    );
    if (fallback) acceptanceCriteria.push(fallback);
  }
  const matched = new Array(acceptanceCriteria.length).fill(false);
  for (const report of reports) {
    const index = acceptanceCriteria.findIndex(
      (statement, candidateIndex) => !matched[candidateIndex] && statement === report.statement,
    );
    if (index >= 0) {
      matched[index] = true;
      continue;
    }
    acceptanceCriteria.push(report.statement);
    matched.push(true);
  }
  return acceptanceCriteria;
}

function legacyReportStatement(statement: string, index: number): string {
  return statement.trim().length > 0
    ? statement
    : `Legacy archived claim ${index + 1}: ${JSON.stringify(statement)}`;
}

function isLegacyCompletionRow(input: unknown): input is object {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    !("completionContract" in input) &&
    !("completionFacts" in input)
  );
}

function legacyCriteria(hash: string, statements: readonly string[]): Criterion[] {
  return statements.map((statement, index) => ({
    id: criterionId(hash, index, statement),
    revision: 1,
    statement,
    required: true,
  }));
}

type LegacyObservation = Readonly<{
  evidence: z.infer<typeof LegacyEvidence>;
  observation: Observation;
}>;

function legacyObservations(
  hash: string,
  evidence: readonly z.infer<typeof LegacyEvidence>[],
): Map<string, LegacyObservation> {
  const observations = new Map<string, LegacyObservation>();
  evidence.forEach((entry, index) => {
    if (observations.has(entry.id)) return;
    observations.set(entry.id, {
      evidence: entry,
      observation: {
        id: `observation:${hash}:${index}:${stableToken(entry.id)}`,
        producer: "legacy-evidence",
        subjectRef: hash,
        basisRef: "legacy-basis",
        artifactRefs: [entry.id],
        provenanceRef: entry.id,
        ancestryRefs: [],
        observedAt: entry.createdAt,
      },
    });
  });
  return observations;
}

function legacyClaims(
  hash: string,
  basisRef: string,
  criteria: readonly Criterion[],
  reports: readonly Readonly<{ statement: string; evidenceIds: readonly string[] }>[],
  observations: ReadonlyMap<string, LegacyObservation>,
): Claim[] {
  const matchedCriterionIds = new Set<string>();
  return reports.map((report, index) => {
    const linkedObservations = report.evidenceIds.map((id) => {
      const linked = observations.get(id);
      if (!linked) throw new Error(`legacy report claim evidence is missing: ${id}`);
      return linked;
    });
    const criterion = criteria.find(
      (candidate) =>
        !matchedCriterionIds.has(candidate.id) && candidate.statement === report.statement,
    );
    if (!criterion) {
      throw new Error(`legacy report claim has no deterministic criterion: ${report.statement}`);
    }
    matchedCriterionIds.add(criterion.id);
    return {
      id: `claim:${hash}:${index}:${stableToken(report.statement)}`,
      criterionId: criterion.id,
      statement: report.statement,
      observationIds: linkedObservations.map(({ observation }) => observation.id),
      basisRef,
      createdAt: Math.max(0, ...linkedObservations.map(({ evidence }) => evidence.createdAt)),
    };
  });
}

function legacyUnresolvedCriterionIds(
  criteria: readonly Criterion[],
  results: readonly CriterionResult[],
): string[] {
  const resolvedCriterionIds = new Set(
    results
      .filter(({ observationIds }) => observationIds.length > 0)
      .map(({ criterionId }) => criterionId),
  );
  return criteria
    .filter(({ id, required }) => required && !resolvedCriterionIds.has(id))
    .map(({ id }) => id);
}

function legacyResults(
  hash: string,
  basisRef: string,
  claims: readonly Claim[],
  observations: ReadonlyMap<string, LegacyObservation>,
): CriterionResult[] {
  const evidenceByObservationId = new Map(
    [...observations.values()].map(({ evidence: entry, observation }) => [observation.id, entry]),
  );
  return claims.flatMap((claim, index): CriterionResult[] => {
    const linked = claim.observationIds.flatMap((id) => {
      const entry = evidenceByObservationId.get(id);
      return entry ? [entry] : [];
    });
    if (linked.length === 0) return [];
    if (!linked.every((entry) => entry.passed)) return [];
    const common = {
      id: `result:${hash}:${index}:${stableToken(claim.id)}`,
      criterionId: claim.criterionId,
      observationIds: claim.observationIds,
      assumptions: ["legacy passed evidence was claimant-supplied"],
      basisRef,
      createdAt: Math.max(...linked.map((entry) => entry.createdAt)),
    };
    return [
      {
        ...common,
        value: "asserted" as const,
        residualRisks: ["legacy evidence was not re-verified"],
      },
    ];
  });
}

function legacyArchiveOverrideResults(
  hash: string,
  basisRef: string,
  criterionIds: readonly string[],
  claims: readonly Claim[],
  completedAt: number | undefined,
): CriterionResult[] {
  if (completedAt === undefined) return [];
  const observationIds = [...new Set(claims.flatMap(({ observationIds: ids }) => ids))].sort();
  return criterionIds.map((criterionId, index) => ({
    id: `result:${hash}:legacy-archive:${index}:${stableToken(criterionId)}`,
    criterionId,
    observationIds,
    value: "asserted",
    assumptions: ["historical completion predated criterion-to-claim linkage"],
    residualRisks: ["legacy acceptance criterion was not independently re-verified"],
    basisRef,
    createdAt: completedAt,
  }));
}

function legacyAdmissions(
  hash: string,
  contract: CompletionContract,
  completedAt: number | undefined,
  usedArchiveOverride: boolean,
  facts: Readonly<{
    claims: readonly Claim[];
    observations: readonly Observation[];
    results: readonly CriterionResult[];
  }>,
  completionReport: CompletionReport | undefined,
): CompletionAdmission[] {
  if (completedAt === undefined) return [];
  const requestId = `completion-request:${hash}:legacy`;
  return [
    {
      version: 1,
      id: `admission:${hash}:legacy:${stableToken(contract.revision)}`,
      requestId,
      requestSnapshot: {
        version: 1,
        id: requestId,
        origin: "recovery",
        workItemHash: hash,
        contractRevision: contract.revision,
        basisRef: contract.basisRef,
        expectedHead: 0,
        claims: [...facts.claims],
        observations: [...facts.observations],
        results: [...facts.results],
        invalidations: [],
        verificationErrors: [],
        effects: [],
      },
      origin: "recovery",
      contractRevision: contract.revision,
      basisRef: contract.basisRef,
      effectiveResultIds: facts.results.map(({ id }) => id),
      unresolvedCriterionIds: [],
      decision: "admit",
      reasonCodes: usedArchiveOverride ? ["legacy_archive_override"] : ["legacy_completed_row"],
      residualRisks: usedArchiveOverride
        ? ["historical report claims did not map every original acceptance criterion"]
        : ["legacy completion retained without retrospective verification"],
      policyRef: "policy:legacy-completion:v1",
      completionReportSnapshot: completionReport,
      completionReportRef:
        completionReport === undefined ? undefined : completionReportReference(completionReport),
      expectedHead: 0,
      recordedHead: 1,
      createdAt: completedAt,
    },
  ];
}
