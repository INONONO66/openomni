import { WorkItem } from "@openomni/protocol";

export function canonicalCompletionRequest(
  input: WorkItem.CompletionRequest,
): WorkItem.CompletionRequest {
  const request = WorkItem.CompletionRequest.parse(input);
  return WorkItem.CompletionRequest.parse({
    ...request,
    claims: sortFacts(request.claims.map(canonicalClaim)),
    observations: sortFacts(request.observations.map(canonicalObservation)),
    results: sortFacts(request.results.map(canonicalResult)),
    invalidations: sortFacts(request.invalidations),
    verificationErrors: sortFacts(request.verificationErrors),
    effects: sortFacts(request.effects),
  });
}

export function completionRequestsMatch(
  left: WorkItem.CompletionRequest,
  right: WorkItem.CompletionRequest,
): boolean {
  return (
    JSON.stringify(canonicalCompletionRequest(left)) ===
    JSON.stringify(canonicalCompletionRequest(right))
  );
}

export function completionReportReference(input: WorkItem.CompletionReport): string {
  return WorkItem.completionReportReference(input);
}

export function completionReportsMatch(
  left: WorkItem.CompletionReport,
  right: WorkItem.CompletionReport,
): boolean {
  return completionReportReference(left) === completionReportReference(right);
}

function canonicalClaim(claim: WorkItem.Claim): WorkItem.Claim {
  return { ...claim, observationIds: sortReferences(claim.observationIds) };
}

function canonicalObservation(observation: WorkItem.Observation): WorkItem.Observation {
  return {
    ...observation,
    artifactRefs: sortReferences(observation.artifactRefs),
    ancestryRefs: sortReferences(observation.ancestryRefs),
  };
}

function canonicalResult(result: WorkItem.CriterionResult): WorkItem.CriterionResult {
  return {
    ...result,
    observationIds: sortReferences(result.observationIds),
    assumptions: sortReferences(result.assumptions),
    residualRisks: sortReferences(result.residualRisks),
  };
}

function sortFacts<T extends Readonly<{ id: string }>>(facts: readonly T[]): T[] {
  return [...facts].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function sortReferences(references: readonly string[]): string[] {
  return [...references].sort();
}
