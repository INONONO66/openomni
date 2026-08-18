import type { WorkItem } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/ledger";
import { z } from "zod";
import type {
  CompletionResultAuthorityCandidate,
  CompletionResultAuthorityPort,
} from "../work-item/completion-admission.js";
import { VerifierRegistry } from "./verifier-registry.js";

/**
 * Recorded verifier input: the durable evidence → verifier-input projection
 * and the result-authority port built on it. This evolves with the
 * VerifierRegistry obligation/read-back vocabulary, not with the admission
 * transaction protocol — which is why it lives in evidence/, one type-only
 * import away from the admission port contract it implements.
 */

const PersistedVerifierInput = z
  .object({
    type: z.literal("verifier_recorded_inputs"),
    version: z.literal(1),
    workItemHash: z.string().min(1),
    basisRef: z.string().min(1),
    criterionId: z.string().min(1),
    verifierKind: VerifierRegistry.ObligationKind,
    recordedInputs: z.record(VerifierRegistry.JsonValue),
  })
  .strict();

export function createDurableCompletionResultAuthorityPort(): CompletionResultAuthorityPort {
  const verifierRegistry = VerifierRegistry.create();
  return Object.freeze({
    validate(candidate: CompletionResultAuthorityCandidate) {
      const item = WorkItemStore.get(candidate.workItemHash);
      if (!item) return { ok: false };
      if (candidate.result.observationIds.length !== 1 || candidate.observations.length !== 1) {
        return { ok: false };
      }
      const observation = candidate.observations[0];
      if (!observation) return { ok: false };
      if (
        observation.id !== candidate.result.observationIds[0] ||
        observation.basisRef !== candidate.basisRef ||
        observation.subjectRef !== candidate.workItemHash
      ) {
        return { ok: false };
      }
      const evidenceId = observation?.artifactRefs[0];
      const evidence = evidenceId ? item.evidence.find(({ id }) => id === evidenceId) : undefined;
      const verifierInput =
        evidence === undefined
          ? undefined
          : durableVerifierInput(item, candidate.criterion, evidence);
      if (!observation || !verifierInput) return { ok: false };

      const verification = verifierRegistry.verify({
        obligationId: candidate.criterion.id,
        kind: verifierInput.kind,
        claim: candidate.criterion.statement,
        recordedInputs: verifierInput.recordedInputs,
      });
      if (verification.type !== "verification_result") return { ok: false };
      return {
        ok:
          verification.status === candidate.result.value &&
          verification.verifierId === candidate.result.verifierRef &&
          (candidate.result.value === "asserted" ||
            verification.checkedPredicate === candidate.result.checkedPredicate) &&
          (verifierInput.kind === "citation_support" ||
            candidate.result.value === "asserted" ||
            candidate.result.checkedPredicate === candidate.criterion.statement) &&
          observation.producer === verification.verifierId &&
          observation.artifactRefs.length === 1 &&
          observation.provenanceRef === evidenceId,
      };
    },
  });
}

export function durableVerifierInput(
  item: WorkItem.Info,
  criterion: WorkItem.Criterion,
  evidence: WorkItem.Evidence,
):
  | Readonly<{
      kind: VerifierRegistry.ObligationKind;
      recordedInputs: Record<string, VerifierRegistry.JsonValue>;
    }>
  | undefined {
  if (evidence.attempt !== item.attempt || evidence.basisRef !== item.completionContract.basisRef) {
    return undefined;
  }
  if (evidence.readBack?.kind === "citation_match") {
    if (evidence.criterionId !== criterion.id) return undefined;
    return {
      kind: "archived_quote_match",
      recordedInputs: {
        archivedText: evidence.readBack.matchedText ?? "",
        quotedText: evidence.readBack.quotedText,
      },
    };
  }
  if (evidence.detail === undefined) return undefined;
  const persisted = PersistedVerifierInput.safeParse(parseJson(evidence.detail));
  if (
    !persisted.success ||
    persisted.data.workItemHash !== item.workItemId ||
    persisted.data.basisRef !== item.completionContract.basisRef ||
    persisted.data.criterionId !== criterion.id
  ) {
    return undefined;
  }
  return {
    kind: persisted.data.verifierKind,
    recordedInputs: persisted.data.recordedInputs,
  };
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}
