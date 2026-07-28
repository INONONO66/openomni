import { WorkItem, type Execution } from "@openomni/protocol";
import { z } from "zod";
import { ReadBackExecutor } from "../../evidence/read-back-executor.js";
import {
  commitWorkerLedgerTransition,
  digest,
  type WorkerLedgerBinding,
  type WorkerLedgerService,
} from "./worker-work-item.js";

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
          .passthrough(),
      )
      .min(1),
    caveats: z.array(z.string().min(1)).default([]),
    followUps: z.array(z.string().min(1)).default([]),
  })
  .passthrough();

const CompletionEnvelope = z
  .object({
    completionReport: CompletionReportDraft,
    readBackRequests: z.array(ReadBackRequestEnvelope).max(MAX_READ_BACK_REQUESTS).default([]),
  })
  .superRefine((envelope, ctx) => {
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
type WorkItemStatus = WorkerLedgerBinding["status"];
type ParsedCompletionEnvelope =
  | { readonly ok: true; readonly envelope: CompletionEnvelope }
  | { readonly ok: false; readonly reason: string };

export interface WorkerCompletionOptions {
  readonly ledger?: WorkerLedgerService;
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
  binding: WorkerLedgerBinding,
  result: Execution.Result,
  options: WorkerCompletionOptions = {},
): Promise<CompletionReflection> {
  const ledger = requireWorkerLedger(options.ledger);
  if (result.status === "succeeded") {
    const parsed = parseCompletionEnvelope(result);
    if (!parsed.ok) return blockCompletion(ledger, binding, parsed.reason);
    try {
      const completionReport = await prepareCompletionReport(
        ledger,
        binding,
        parsed.envelope,
        options,
      );
      const current = (await ledger.resolveWorkByRunId(binding.runId)) ?? binding;
      assertEvidenceCoverage(current, completionReport);
      await commitWorkerLedgerTransition(ledger, current, {
        transitionId: "DP-07",
        command: "kernel.dispatch.submit_completion.v1",
        requestKey: `${binding.runId}:completion-candidate`,
        evidenceRef: digest(completionReport),
        facts: completionReport,
      });
      return completionReflection(
        ledger,
        binding.runId,
        true,
        "completion candidate awaits kernel verifier verdicts and admission",
      );
    } catch (err) {
      return blockCompletion(ledger, binding, err instanceof Error ? err.message : String(err));
    }
  }
  if (result.status === "cancelled") {
    await commitWorkerLedgerTransition(ledger, binding, {
      transitionId: "DP-09",
      command: "kernel.dispatch.cancel_work.v1",
      requestKey: `${binding.runId}:cancelled`,
      facts: { status: result.status },
    });
  } else if (result.status === "failed") {
    await commitWorkerLedgerTransition(ledger, binding, {
      transitionId: "DP-10",
      command: "kernel.dispatch.fail_work.v1",
      requestKey: `${binding.runId}:failed`,
      facts: { reason: result.error ?? result.status },
    });
  } else if (result.status === "interrupted") {
    await commitWorkerLedgerTransition(ledger, binding, {
      transitionId: "DP-11",
      command: "kernel.dispatch.interrupt_attempt.v1",
      requestKey: `${binding.runId}:interrupted`,
      facts: { reason: result.error ?? result.status },
    });
  }
  return completionReflection(ledger, binding.runId, false);
}

export function requireWorkerLedger(ledger: WorkerLedgerService | undefined): WorkerLedgerService {
  if (!ledger) throw new Error("worker ledger transition/query service is required");
  return ledger;
}

function parseCompletionEnvelope(result: Execution.Result): ParsedCompletionEnvelope {
  if (!result.output) return { ok: false, reason: "completion report is required" };
  const parsedJson = parseJson(result.output);
  if (!parsedJson.ok) return { ok: false, reason: "completion report is required" };
  const parsed = CompletionEnvelope.safeParse(parsedJson.value);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  return { ok: false, reason: `completion report is invalid: ${parsed.error.issues[0]?.message}` };
}

function parseJson(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

async function prepareCompletionReport(
  ledger: WorkerLedgerService,
  binding: WorkerLedgerBinding,
  envelope: CompletionEnvelope,
  options: WorkerCompletionOptions,
): Promise<WorkItem.CompletionReport> {
  if (envelope.readBackRequests.length === 0) {
    return WorkItem.CompletionReport.parse(envelope.completionReport);
  }

  const evidenceIdsByClaim = new Map<number, string[]>();
  const now = options.now ?? Date.now;
  const recordReadBack = options.readBackRecorder ?? ReadBackExecutor.record;
  const deadlineAt = now() + resolveReadBackEnvelopeTimeoutMs(options);
  for (const readBack of envelope.readBackRequests) {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) throw new Error("read-back envelope deadline exceeded");
    const evidenceId = await recordReadBack(
      ledger,
      binding,
      applySharedDeadline(readBack.request, remainingMs),
      options.readBack,
    );
    if (deadlineAt - now() <= 0) throw new Error("read-back envelope deadline exceeded");
    const existing = evidenceIdsByClaim.get(readBack.claimIndex) ?? [];
    evidenceIdsByClaim.set(readBack.claimIndex, [...existing, evidenceId]);
  }

  return WorkItem.CompletionReport.parse({
    ...envelope.completionReport,
    claims: attachReadBackEvidence(envelope.completionReport, evidenceIdsByClaim),
  });
}

function assertEvidenceCoverage(
  work: WorkerLedgerBinding,
  report: WorkItem.CompletionReport,
): void {
  const committed = new Set([...work.evidenceRefs, ...work.readbackRefs]);
  for (const claim of report.claims) {
    if (claim.evidenceIds.length === 0) throw new Error("completion claim has no evidence");
    const missing = claim.evidenceIds.find((evidenceId) => !committed.has(evidenceId));
    if (missing) throw new Error(`completion claim references uncommitted evidence ${missing}`);
  }
}

function attachReadBackEvidence(
  report: CompletionReportDraft,
  evidenceIdsByClaim: ReadonlyMap<number, readonly string[]>,
): WorkItem.CompletionReport["claims"] {
  return report.claims.map((claim, index) => {
    const readBackEvidenceIds = evidenceIdsByClaim.get(index);
    if (!readBackEvidenceIds) return claim;
    return { ...claim, evidenceIds: [...claim.evidenceIds, ...readBackEvidenceIds] };
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
  ledger: WorkerLedgerService,
  binding: WorkerLedgerBinding,
  description: string,
): Promise<CompletionReflection> {
  const blockerRef = digest({ description });
  await commitWorkerLedgerTransition(ledger, binding, {
    transitionId: "WI-08",
    command: "kernel.work.add_blocker.v1",
    requestKey: `${binding.runId}:completion-blocker:${blockerRef}`,
    evidenceRef: blockerRef,
    facts: { description },
  });
  return completionReflection(ledger, binding.runId, true, description);
}

async function completionReflection(
  ledger: WorkerLedgerService,
  runId: string,
  completionBlocked: boolean,
  completionBlocker?: string,
): Promise<CompletionReflection> {
  const work = await ledger.resolveWorkByRunId(runId);
  return {
    ...(work ? { workItemStatus: work.status } : {}),
    completionBlocked,
    ...(completionBlocker ? { completionBlocker } : {}),
  };
}
