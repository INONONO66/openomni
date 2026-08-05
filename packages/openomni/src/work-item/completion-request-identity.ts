import { createHash } from "node:crypto";
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

export function completionRequestRoot(input: WorkItem.CompletionRequest): string {
  const { expectedHead: _expectedHead, ...request } = canonicalCompletionRequest(input);
  return digest(request);
}

export function completionRequestEnvelopeDigest(
  input: WorkItem.CompletionRequest,
  report: WorkItem.CompletionReport,
): string {
  return digest({
    requestRoot: completionRequestRoot(input),
    completionReportRef: WorkItem.completionReportReference(report),
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

function digest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
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
  return [...new Set(references)].sort();
}
