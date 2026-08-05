import { z } from "zod";
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

  const contract: CompletionContract = {
    version: 1,
    revision: "legacy-v1",
    basisRef: "legacy-basis",
  };
  const acceptanceCriteria = legacyAcceptanceCriteria(parsed.data);
  const criteria = legacyCriteria(parsed.data.hash, acceptanceCriteria);
  const observationsByEvidenceId = legacyObservations(parsed.data.hash, parsed.data.evidence);
  const claims = legacyClaims(
    parsed.data.hash,
    contract.basisRef,
    criteria,
    parsed.data.completionReport?.claims ?? [],
    observationsByEvidenceId,
  );
  const observations = [...observationsByEvidenceId.values()].map(({ observation }) => observation);
  const results = legacyResults(
    parsed.data.hash,
    contract.basisRef,
    claims,
    observationsByEvidenceId,
  );
  const admissions = legacyAdmissions(
    parsed.data.hash,
    contract,
    parsed.data.timestamps.completed,
    {
      claims,
      observations,
      results,
    },
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
        recordedHead,
      }
    : undefined;

  return {
    ...parsed.data,
    revision: recordedHead,
    acceptanceCriteria,
    completionContract: contract,
    completionFacts: facts,
    completionTerminalReceipt,
  };
}

function legacyAcceptanceCriteria(parsed: z.infer<typeof LegacyWorkItem>): string[] {
  const acceptanceCriteria = parsed.acceptanceCriteria.filter(
    (statement) => statement.trim().length > 0,
  );
  if (acceptanceCriteria.length === 0 && (parsed.completionReport?.claims.length ?? 0) === 0) {
    const fallback = [parsed.goal, parsed.name, parsed.hash].find(
      (statement) => statement.trim().length > 0,
    );
    if (fallback) acceptanceCriteria.push(fallback);
  }
  const matched = new Array(acceptanceCriteria.length).fill(false);
  for (const report of parsed.completionReport?.claims ?? []) {
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
      observationIds: report.evidenceIds.flatMap((id) => {
        const observation = observations.get(id)?.observation;
        return observation ? [observation.id] : [];
      }),
      basisRef,
      createdAt: Math.max(
        0,
        ...report.evidenceIds.map((id) => observations.get(id)?.evidence.createdAt ?? 0),
      ),
    };
  });
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

function legacyAdmissions(
  hash: string,
  contract: CompletionContract,
  completedAt: number | undefined,
  facts: Readonly<{
    claims: readonly Claim[];
    observations: readonly Observation[];
    results: readonly CriterionResult[];
  }>,
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
      reasonCodes: ["legacy_completed_row"],
      residualRisks: ["legacy completion retained without retrospective verification"],
      policyRef: "policy:legacy-completion:v1",
      expectedHead: 0,
      recordedHead: 1,
      createdAt: completedAt,
    },
  ];
}
