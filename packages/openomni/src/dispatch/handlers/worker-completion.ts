import type { PolicyEngine } from "@openomni/policy";
import { WorkItem, type Execution } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { ReadBackExecutor } from "../../evidence/read-back-executor.js";
import type { CompletionStakesResolver } from "../../work-item/completion-admission-authority.js";
import type { CompletionBoundaryOutcome } from "../../work-item/completion-admission-boundary.js";
import type { CompletionSourceOrigin } from "../../work-item/completion-origin.js";
import {
  admitWorkerCompletion,
  replayWorkerCompletion,
  WorkerCriterionFactInput,
  type WorkerReadBackEvidenceBinding,
} from "./worker-completion-admission.js";

const MAX_READ_BACK_REQUESTS = 5;
const MAX_READ_BACK_TIMEOUT_MS = 10_000;
const MAX_READ_BACK_BODY_BYTES = 1_000_000;

const ReadBackRequest = WorkItem.ReadBackRequest.superRefine((request, ctx) => {
  if (request.timeoutMs !== undefined && request.timeoutMs > MAX_READ_BACK_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      message: `read-back timeoutMs must be at most ${MAX_READ_BACK_TIMEOUT_MS}`,
      path: ["timeoutMs"],
    });
  }
  if (request.maxBodyBytes > MAX_READ_BACK_BODY_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `read-back maxBodyBytes must be at most ${MAX_READ_BACK_BODY_BYTES}`,
      path: ["maxBodyBytes"],
    });
  }
});

type ReadBackRequest = z.infer<typeof ReadBackRequest>;

const ReadBackRequestEnvelope = WorkItem.ReadBackRequestEnvelope.extend({
  request: ReadBackRequest,
});

const CompletionReportDraft = z
  .object({
    summary: z.string().min(1),
    claims: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            evidenceIds: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1),
    caveats: z.array(z.string().min(1)).default([]),
    followUps: z.array(z.string().min(1)).default([]),
  })
  .strict();

const CompletionEnvelope = z
  .object({
    deliverable: z.unknown().optional(),
    completionReport: CompletionReportDraft,
    criterionFacts: z.array(WorkerCriterionFactInput).min(1).max(256),
    readBackRequests: z.array(ReadBackRequestEnvelope).max(MAX_READ_BACK_REQUESTS).default([]),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const criterionIndexes = new Set<number>();
    for (const [factIndex, fact] of envelope.criterionFacts.entries()) {
      if (criterionIndexes.has(fact.criterionIndex)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate criterionIndex ${fact.criterionIndex}`,
          path: ["criterionFacts", factIndex, "criterionIndex"],
        });
      }
      criterionIndexes.add(fact.criterionIndex);
    }
    for (const [requestIndex, readBack] of envelope.readBackRequests.entries()) {
      if (readBack.claimIndex >= envelope.completionReport.claims.length) {
        ctx.addIssue({
          code: "custom",
          message: "read-back request claimIndex is out of range",
          path: ["readBackRequests", requestIndex, "claimIndex"],
        });
      }
    }
  });

type CompletionEnvelope = z.infer<typeof CompletionEnvelope>;
type CompletionReportDraft = z.infer<typeof CompletionReportDraft>;
type WorkItemStatus = ReturnType<typeof WorkItem.deriveStatus>;
type ParsedCompletionEnvelope =
  | { readonly ok: true; readonly envelope: CompletionEnvelope }
  | { readonly ok: false; readonly reason: string };

export type CompletionPolicyEngine = ReturnType<typeof PolicyEngine.create>;

export interface WorkerCompletionOptions {
  readonly sourceOrigin: CompletionSourceOrigin;
  readonly completionPolicyEngine: CompletionPolicyEngine;
  readonly stakesResolver?: CompletionStakesResolver;
  readonly readBack?: ReadBackExecutor.Options;
  readonly readBackEnvelopeTimeoutMs?: number;
  readonly readBackRecorder?: typeof ReadBackExecutor.record;
  readonly now?: () => number;
}

export type CompletionReflection = {
  readonly workItemStatus?: WorkItemStatus;
  readonly completionBlocked: boolean;
  readonly completionBlocker?: string;
};

export async function reflectCoordinatorResult(
  workItemHash: string,
  result: Execution.Result,
  options: WorkerCompletionOptions,
): Promise<CompletionReflection> {
  if (result.status === "succeeded") {
    const parsed = parseCompletionEnvelope(result);
    if (!parsed.ok) {
      return blockCompletion(workItemHash, parsed.reason);
    }
    try {
      const replay = await replayWorkerCompletion({
        workItemHash,
        result,
        policyEngine: options.completionPolicyEngine,
        ...(options.stakesResolver === undefined ? {} : { stakesResolver: options.stakesResolver }),
        now: options.now ?? Date.now,
      });
      if (replay) return completionOutcomeReflection(workItemHash, replay);
      const prepared = await prepareCompletionReport(workItemHash, parsed.envelope, options);
      const outcome = await admitWorkerCompletion({
        workItemHash,
        result,
        sourceOrigin: options.sourceOrigin,
        criterionFacts: parsed.envelope.criterionFacts,
        completionReport: prepared.report,
        policyEngine: options.completionPolicyEngine,
        readBackEvidenceBindings: prepared.readBackEvidenceBindings,
        ...(options.stakesResolver === undefined ? {} : { stakesResolver: options.stakesResolver }),
        now: options.now ?? Date.now,
      });
      return completionOutcomeReflection(workItemHash, outcome);
    } catch (err) {
      return blockCompletion(workItemHash, err instanceof Error ? err.message : String(err));
    }
  }
  if (result.status === "cancelled") {
    await WorkItemStore.cancel(workItemHash);
    return completionReflection(workItemHash, false);
  }
  if (result.status === "failed" || result.status === "interrupted") {
    await WorkItemStore.fail(workItemHash, result.error ?? result.status);
  }
  return completionReflection(workItemHash, false);
}

async function completionOutcomeReflection(
  workItemHash: string,
  outcome: CompletionBoundaryOutcome,
): Promise<CompletionReflection> {
  if (outcome.completed) return completionReflection(workItemHash, false);
  return blockCompletion(
    workItemHash,
    `completion admission ${outcome.admission.decision}: ${outcome.admission.reasonCodes.join(", ")}`,
  );
}

function parseCompletionEnvelope(result: Execution.Result): ParsedCompletionEnvelope {
  if (!result.output) return { ok: false, reason: "completion report is required" };
  const parsedJson = parseJson(result.output);
  if (!parsedJson.ok) return { ok: false, reason: "completion report is required" };
  const parsed = CompletionEnvelope.safeParse(parsedJson.value);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".");
  const detail = field && issue ? `${field}: ${issue.message}` : issue?.message;
  return { ok: false, reason: `completion report is invalid: ${detail}` };
}

function parseJson(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

type PreparedCompletionReport = Readonly<{
  report: WorkItem.CompletionReport;
  readBackEvidenceBindings: ReadonlyMap<number, WorkerReadBackEvidenceBinding>;
}>;

async function prepareCompletionReport(
  workItemHash: string,
  envelope: CompletionEnvelope,
  options: WorkerCompletionOptions,
): Promise<PreparedCompletionReport> {
  if (envelope.readBackRequests.length === 0) {
    return {
      report: WorkItem.CompletionReport.parse(envelope.completionReport),
      readBackEvidenceBindings: new Map(),
    };
  }

  const item = WorkItemStore.get(workItemHash);
  if (!item) throw new Error(`WorkItem not found: ${workItemHash}`);
  const evidenceIdsByClaim = new Map<number, string[]>();
  const readBackEvidenceBindings = new Map<number, WorkerReadBackEvidenceBinding>();
  const now = options.now ?? Date.now;
  const recordReadBack = options.readBackRecorder ?? ReadBackExecutor.record;
  const deadlineAt = now() + resolveReadBackEnvelopeTimeoutMs(options);
  for (const [requestIndex, readBack] of envelope.readBackRequests.entries()) {
    if (!item.completionFacts.criteria[readBack.criterionIndex]) {
      throw new Error(`read-back completion criterion is unknown: ${readBack.criterionIndex}`);
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) throw new Error("read-back envelope deadline exceeded");
    const updated = await recordReadBack(
      workItemHash,
      applySharedDeadline(readBack.request, remainingMs),
      options.readBack,
    );
    if (deadlineAt - now() <= 0) throw new Error("read-back envelope deadline exceeded");
    const evidenceId = updated?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("read-back evidence was not recorded");
    const existing = evidenceIdsByClaim.get(readBack.claimIndex) ?? [];
    evidenceIdsByClaim.set(readBack.claimIndex, [...existing, evidenceId]);
    readBackEvidenceBindings.set(requestIndex, {
      evidenceId,
      criterionIndex: readBack.criterionIndex,
    });
  }

  return {
    report: WorkItem.CompletionReport.parse({
      ...envelope.completionReport,
      claims: attachReadBackEvidence(envelope.completionReport, evidenceIdsByClaim),
    }),
    readBackEvidenceBindings,
  };
}

function attachReadBackEvidence(
  report: CompletionReportDraft,
  evidenceIdsByClaim: ReadonlyMap<number, readonly string[]>,
): WorkItem.CompletionReport["claims"] {
  return report.claims.map((claim, index) => {
    const claimReadBackEvidence = evidenceIdsByClaim.get(index);
    if (!claimReadBackEvidence) return claim;
    return {
      ...claim,
      evidenceIds: [...claim.evidenceIds, ...claimReadBackEvidence],
    };
  });
}

function resolveReadBackEnvelopeTimeoutMs(options: WorkerCompletionOptions): number {
  const configured = options.readBackEnvelopeTimeoutMs;
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return MAX_READ_BACK_TIMEOUT_MS;
  }
  return Math.min(Math.ceil(configured), MAX_READ_BACK_TIMEOUT_MS);
}

function applySharedDeadline(request: ReadBackRequest, remainingMs: number): ReadBackRequest {
  const timeoutMs = Math.max(
    1,
    Math.min(request.timeoutMs ?? MAX_READ_BACK_TIMEOUT_MS, Math.floor(remainingMs)),
  );
  switch (request.kind) {
    case "url_fetch":
      return { ...request, timeoutMs };
    case "api_query":
      return { ...request, timeoutMs };
    case "citation_match":
      return { ...request, timeoutMs };
  }
}

async function blockCompletion(
  workItemHash: string,
  description: string,
): Promise<CompletionReflection> {
  await WorkItemStore.addBlocker(workItemHash, {
    kind: "error",
    description,
  });
  return completionReflection(workItemHash, true, description);
}

function completionReflection(
  workItemHash: string,
  completionBlocked: boolean,
  completionBlocker?: string,
): CompletionReflection {
  const workItem = WorkItemStore.get(workItemHash);
  return {
    ...(workItem ? { workItemStatus: WorkItem.deriveStatus(workItem) } : {}),
    completionBlocked,
    ...(completionBlocker ? { completionBlocker } : {}),
  };
}
