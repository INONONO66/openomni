import type { LedgerAction, PlainObject, PlainValue } from "@openomni/protocol";
import { canonicalDigest, PlainValueSchema, type SessionTransition } from "@openomni/protocol";
import { findSessionRequest } from "./session-request";
import type { PolicyEvaluation, PolicyEvaluationInput } from "@openomni/policy";

import { runWaveBodies, waveBodyScope, type WaveControl } from "./core/execution/tool-wave";

const CORE_KINDS = new Set(["prompt", "turn", "llm", "tool", "compaction", "message"]);
import { createExecutionRecord, type ToolObservationStatus } from "./executor-record";

class UnregisteredExecutionKindError extends Error {
  readonly code = "unregistered_execution_kind";

  constructor(readonly kind: string) {
    super(`unregistered execution kind: ${kind}`);
    this.name = "UnregisteredExecutionKindError";
  }
}

import type {
  DurableExecutor,
  ExecutionApprovalRequest,
  ExecutionBatchItem,
  ExecutionBatchResult,
  ExecutionRequest,
  ExecutionResult,
  ExecutorOptions,
  RecoverySite,
} from "./executor-contract";
import { createExecutionApprovals } from "./executor-approval";
import { createExecutionRecovery, recoveryClassification } from "./executor-recovery";
import { ExecutionApprovalError } from "./executor-contract";
import { createAttemptRunner } from "./executor-attempts";
import { createStopJudge } from "./executor-stop";
export { ExecutionApprovalError } from "./executor-contract";
export type {
  DurableExecutor,
  ExecutionLedger,
  Executor,
  ExecutionRequest,
  ExecutionApprovals,
  ExecutionApprovalRequest,
  ExecutionBatchResult,
  ExecutionResult,
  ExecutorOptions,
} from "./executor-contract";

type WaveOutcome = Awaited<ReturnType<typeof runWaveBodies>>[number];
type SettledOutcome = Exclude<WaveOutcome, { readonly status: "cancelled" }>;
type ApprovalDecision = Awaited<
  ReturnType<ReturnType<typeof createExecutionApprovals>["awaitApproval"]>
>;
type PostOutcome = Exclude<ExecutionResult, { readonly terminal: "blocked_pre" }>;
const RESULT_ECHO_KINDS = new Set<string>(["compaction", "tool", "message"]);

function ambientSignal(): AbortSignal {
  const scope = waveBodyScope.getStore();
  return scope === undefined ? new AbortController().signal : scope.signal;
}

function policyPoint(
  request: ExecutionRequest,
  phase: "pre" | "post",
): { readonly kind: string; readonly phase: "pre" | "post"; readonly op: string } {
  // Compaction is the existing turn.post/compaction policy operation, even
  // though its durable evidence has the dedicated compaction kind; its typed
  // compensation keeps its own op there so a policy can pin a projection.
  if (request.kind !== "compaction") return { kind: request.kind, phase, op: request.op };
  return { kind: "turn", phase: "post", op: request.op === "compact" ? "compaction" : request.op };
}

function messageContext(request: ExecutionRequest): Pick<PolicyEvaluationInput, "message"> {
  return request.message === undefined ? {} : { message: request.message };
}

function observedCallId(request: ExecutionRequest): string | null {
  return request.toolObservation?.callId ?? null;
}

function deniedReason(decision: PolicyEvaluation): string {
  return decision.reason ?? "denied";
}

function approvalRequired(stage: BatchStage): boolean {
  return stage.pre.verdict === "require_approval" || stage.request.approval?.required === true;
}

function guardsWave(stage: BatchStage): boolean {
  return approvalRequired(stage) || stage.request.originalAction !== undefined;
}

function assertFreshRevisions(
  request: ExecutionRequest,
  captured: SessionTransition.Request | undefined,
): void {
  if (
    captured !== undefined &&
    request.domainRevisions !== undefined &&
    canonicalDigest({ ...request.domainRevisions() }) !== canonicalDigest(captured.domainRevisions)
  )
    throw new Error("stale_domain_revision");
}

function refusalOrRethrow(error: Error): "refuse" {
  if (error instanceof ExecutionApprovalError) return "refuse";
  throw error;
}

function positional<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("wave lost positional result");
  return value;
}

function singleResult(results: readonly ExecutionBatchResult[]): ExecutionResult {
  const result = results[0];
  if (result === undefined) throw new Error("single execution lost its result");
  if (result.terminal === "failed") throw result.error;
  if (result.terminal === "cancelled") throw new DOMException("execution cancelled", "AbortError");
  return result;
}

interface BatchStage {
  readonly item: ExecutionBatchItem;
  readonly request: ExecutionRequest;
  readonly kind: LedgerAction.Kind;
  readonly pre: PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };
}
type AdmittedStage = BatchStage & { readonly intent: LedgerAction.Receipt | undefined };

export function createExecutor(options: ExecutorOptions): DurableExecutor {
  const {
    commit,
    appendFailure,
    appendIntent,
    appendResult,
    publishToolStarted,
    publishToolTerminal,
  } = createExecutionRecord(options);
  const { approvals, awaitApproval } = createExecutionApprovals(options);
  const recovery = createExecutionRecovery(options, { appendResult });
  const kinds = new Set([
    ...CORE_KINDS,
    ...(options.extensionKinds ?? []).map((registration) => registration.kind),
  ]);

  function turnId(): string | null {
    return options.identity.turnId ?? options.identity.parentActionId;
  }

  function approvalIdentity(): Pick<
    ExecutionApprovalRequest,
    "sessionId" | "turnId" | "toolsHash" | "toolsGeneration"
  > {
    const { sessionId, toolsHash, toolsGeneration } = options.identity;
    return {
      sessionId,
      turnId: turnId(),
      ...(toolsHash === undefined ? {} : { toolsHash }),
      ...(toolsGeneration === undefined ? {} : { toolsGeneration }),
    };
  }

  async function decide(
    request: ExecutionRequest,
    phase: "pre" | "post",
    value: PlainValue,
    parentId = options.identity.parentActionId,
  ): Promise<PolicyEvaluation & { readonly receipt: LedgerAction.Receipt }> {
    const point = policyPoint(request, phase);
    const input: PolicyEvaluationInput = {
      ...point,
      role: options.identity.role,
      sessionId: options.identity.sessionId,
      ...messageContext(request),
      value,
    };
    const decision = options.policy.evaluate(input);
    const receipt = await commit({
      id: options.entropy(),
      parentId,
      sessionId: options.identity.sessionId,
      kind: "policy.decision",
      intent: {
        encodingVersion: 1,
        value: {
          hook: `${point.kind}.${point.phase}`,
          op: request.op,
          generation: decision.generation,
          matchedRuleIds: [...decision.matchedRuleIds],
          verdict: decision.verdict,
          inputHash: decision.inputHash,
        },
      },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "result",
          reason: decision.reason ?? null,
        },
      },
      ts: options.clock(),
      irreversible: true,
    });
    return { ...decision, receipt };
  }

  async function run<T extends PlainValue>(
    request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt) => Promise<T>,
  ): Promise<ExecutionResult> {
    return singleResult(await runBatch([{ request, body }], { signal: ambientSignal() }));
  }

  function retainFor(inherited: WaveControl | undefined, control: WaveControl) {
    // A captured executor keeps its turn's owner outside the ambient scope.
    return options.retainEffect ?? inherited?.retain ?? control.retain;
  }

  async function runBatch(
    items: readonly ExecutionBatchItem[],
    control: WaveControl,
  ): Promise<readonly ExecutionBatchResult[]> {
    const controller = new AbortController();
    const inherited = waveBodyScope.getStore();
    const signal = AbortSignal.any([
      control.signal,
      controller.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
      ...(inherited === undefined ? [] : [inherited.signal]),
    ]);
    try {
      return await executeBatch(items, { signal, retain: retainFor(inherited, control) });
    } finally {
      controller.abort();
    }
  }

  function stageCallId(stage: BatchStage): string {
    return stage.request.toolObservation?.callId ?? stage.pre.receipt.action.id;
  }

  function invocationFor(stage: BatchStage, waveId: string) {
    return {
      effectHash: canonicalDigest(stage.request.effect),
      effect: stage.request.effect,
      callId: stageCallId(stage),
      turnId: turnId(),
      waveId,
      sequential: stage.item.sequential ?? false,
      approvalRequired: approvalRequired(stage),
      domainRevisions: { ...stage.request.approval?.domainRevisions },
      recovery: recoveryClassification(stage.request),
    };
  }

  async function admitStage(stage: BatchStage, waveId: string): Promise<AdmittedStage> {
    if (stage.pre.verdict === "deny") return { ...stage, intent: undefined };
    const original = stage.request.originalAction;
    if (original !== undefined)
      return { ...stage, intent: { action: original, revision: original.ordinal } };
    const intent = await appendIntent({
      parentId: options.identity.parentActionId,
      kind: stage.kind,
      op: stage.request.op,
      value: stage.pre.value,
      invocation: invocationFor(stage, waveId),
    });
    return { ...stage, intent };
  }

  async function stageAll(items: readonly ExecutionBatchItem[]): Promise<BatchStage[]> {
    // Salvaged staged-pre algorithm: every decision precedes every intent/body.
    const stages: BatchStage[] = [];
    for (const item of items) {
      const request = { ...item.request, intent: clonePlainValue(item.request.intent) };
      const kind = registeredKind(request);
      const pre = await decide(request, "pre", request.intent);
      stages.push({ item, request, kind, pre });
    }
    return stages;
  }

  async function admitAll(stages: readonly BatchStage[]): Promise<AdmittedStage[]> {
    const admitted: AdmittedStage[] = [];
    for (const stage of stages) {
      admitted.push(await admitStage(stage, (stages[0] ?? stage).pre.receipt.action.id));
    }
    return admitted;
  }

  function needsApproval(stage: AdmittedStage, intent: LedgerAction.Receipt): boolean {
    return approvalRequired(stage) || originalRequest(intent.action.id) !== undefined;
  }

  function approvalRequestFor(
    stage: AdmittedStage,
    intent: LedgerAction.Receipt,
  ): Omit<ExecutionApprovalRequest, "durable"> {
    return {
      id: intent.action.id,
      ...approvalIdentity(),
      callId: stage.request.toolObservation?.callId ?? intent.action.id,
      inputHash: canonicalDigest(stage.request.intent),
      generation: stage.pre.generation,
      revision: stage.pre.receipt.revision,
      policyDecisionId: stage.pre.receipt.action.id,
      intent: stage.request.intent,
    };
  }

  function approvalBindingFor(stage: AdmittedStage, intent: LedgerAction.Receipt) {
    return {
      effect: stage.request.effect,
      domainRevisions: stage.request.approval?.domainRevisions,
      revisions: stage.request.domainRevisions,
      timeoutMs: stage.request.approval?.timeoutMs,
      original: originalRequest(intent.action.id),
    };
  }

  async function decideApproval(
    stage: AdmittedStage,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const intent = stage.intent;
    if (intent === undefined || !needsApproval(stage, intent)) return "approve";
    return awaitApproval(
      approvalRequestFor(stage, intent),
      signal,
      approvalBindingFor(stage, intent),
    ).catch(refusalOrRethrow);
  }

  async function recordApplication(
    stage: AdmittedStage,
    intent: LedgerAction.Receipt,
    guardedWave: boolean,
  ): Promise<void> {
    const applicationId = `${intent.action.id}:application`;
    if (options.ledger.actions?.().some((action) => action.id === applicationId))
      throw new Error("outcome_unknown");
    if (!guardedWave) return;
    await commit({
      id: applicationId,
      parentId: intent.action.id,
      sessionId: options.identity.sessionId,
      kind: stage.kind,
      intent: { encodingVersion: 1, value: { phase: "application", op: stage.request.op } },
      effect: {
        encodingVersion: 1,
        value: { phase: "application", inputHash: canonicalDigest(stage.request.intent) },
      },
      ts: options.clock(),
      irreversible: true,
    });
  }

  function assertApprovalLive(captured: SessionTransition.Request | undefined): void {
    if (captured !== undefined && options.ledger.validateRequest?.(captured) === false)
      throw new ExecutionApprovalError("stale_approval");
  }

  async function runStageBody(
    stage: AdmittedStage,
    decision: ApprovalDecision,
    guardedWave: boolean,
    onStart: (startedAt: number | undefined) => void,
  ): Promise<PlainValue> {
    const intent = stage.intent;
    if (intent === undefined || stage.pre.verdict === "deny" || decision !== "approve") return null;
    const captured = originalRequest(intent.action.id);
    assertFreshRevisions(stage.request, captured);
    await recordApplication(stage, intent, guardedWave);
    assertFreshRevisions(stage.request, captured);
    assertApprovalLive(captured);
    onStart(publishToolStarted(stage.request));
    return stage.item.body(intent);
  }

  async function executeBatch(
    items: readonly ExecutionBatchItem[],
    control: WaveControl,
  ): Promise<readonly ExecutionBatchResult[]> {
    waveBodyScope.getStore()?.signal.throwIfAborted();
    const stages = await stageAll(items);
    const admitted = await admitAll(stages);
    const guardedWave = stages.some(guardsWave);
    const decisions = await Promise.all(
      admitted.map((stage) => decideApproval(stage, control.signal)),
    );
    const started = new Map<number, number | undefined>();
    const outcomes = await runWaveBodies(
      admitted.map((stage, index) => ({
        ...(stage.item.sequential ? { sequential: true as const } : {}),
        run: () =>
          runStageBody(stage, positional(decisions, index), guardedWave, (startedAt) => {
            started.set(index, startedAt);
          }),
      })),
      control,
    );
    const results: ExecutionBatchResult[] = [];
    for (const [index, stage] of admitted.entries()) {
      results.push(
        await finishStage(
          stage,
          positional(outcomes, index),
          positional(decisions, index),
          started.get(index),
        ),
      );
    }
    return results;
  }

  async function finishCancelled(
    stage: AdmittedStage,
    startedAt: number | undefined,
  ): Promise<ExecutionBatchResult> {
    if (stage.intent !== undefined)
      await appendResult({ kind: stage.kind, op: stage.request.op }, stage.intent.action.id, {
        phase: "result",
        terminal: "cancelled",
        callId: observedCallId(stage.request),
        ...projectToolResult(stage.request, { terminal: "cancelled" }),
      });
    publishToolTerminal(stage.request, startedAt, "error");
    return { terminal: "cancelled" };
  }

  function blockedPreReason(stage: AdmittedStage, decision: ApprovalDecision): string {
    if (stage.pre.verdict === "deny") return deniedReason(stage.pre);
    return decision === "timeout" ? "approval_timeout" : "approval_refused";
  }

  async function finishBlockedPre(
    stage: AdmittedStage,
    decision: ApprovalDecision,
  ): Promise<ExecutionBatchResult> {
    const reason = blockedPreReason(stage, decision);
    if (stage.intent !== undefined)
      await appendResult({ kind: stage.kind, op: stage.request.op }, stage.intent.action.id, {
        phase: "result",
        terminal: "blocked_pre",
        reason,
        callId: observedCallId(stage.request),
        ...projectToolResult(stage.request, { terminal: "blocked_pre", reason }),
      });
    return { terminal: "blocked_pre", reason };
  }

  async function finishRejected(
    stage: AdmittedStage,
    intent: LedgerAction.Receipt,
    error: Error,
    startedAt: number | undefined,
  ): Promise<ExecutionBatchResult> {
    if (error.message === "outcome_unknown") {
      await appendResult({ kind: stage.kind, op: stage.request.op }, intent.action.id, {
        phase: "result",
        terminal: "outcome_unknown",
        ...projectToolResult(stage.request, { terminal: "failed", error }),
      });
    } else
      await appendFailure(
        { kind: stage.kind, op: stage.request.op },
        intent.action.id,
        stage.request.effect,
        error,
        stage.request.toolObservation?.callId,
        stage.request.toolResult?.({ terminal: "failed", error }),
      );
    publishToolTerminal(stage.request, startedAt, "error");
    return { terminal: "failed", error };
  }

  async function completeStage(
    stage: AdmittedStage,
    intent: LedgerAction.Receipt,
    value: PlainValue,
    startedAt: number | undefined,
  ): Promise<ExecutionBatchResult> {
    // The body has settled: a completion exception is recovered from that
    // evidence, never by running the body again or inventing a post verdict.
    let site: RecoverySite = "post_policy";
    const complete = async (): Promise<ExecutionBatchResult> => {
      const post = await decide(stage.request, "post", {
        intent: stage.request.intent,
        effect: stage.request.effect,
        result: value,
      });
      site = "reverter";
      const settled = await settlePost(stage.request, post, value);
      site = "result_commit";
      return finishRun(stage.request, stage.kind, intent.action.id, startedAt, value, settled);
    };
    return complete().catch(async (error: Error) => {
      const recovered = await recovery.recoverCompletion(
        intent.action.id,
        stage.request,
        site,
        error,
        value,
      );
      publishToolTerminal(stage.request, startedAt, "error");
      return recovered;
    });
  }

  async function finishAdmitted(
    stage: AdmittedStage,
    outcome: SettledOutcome,
    startedAt: number | undefined,
  ): Promise<ExecutionBatchResult> {
    const intent = stage.intent;
    if (intent === undefined) throw new Error("wave lost admitted intent");
    if (outcome.status === "rejected")
      return finishRejected(stage, intent, outcome.error, startedAt);
    return completeStage(stage, intent, clonePlainValue(outcome.value), startedAt);
  }

  async function finishStage(
    stage: AdmittedStage,
    outcome: WaveOutcome,
    decision: ApprovalDecision,
    startedAt: number | undefined,
  ): Promise<ExecutionBatchResult> {
    if (outcome.status === "cancelled") return finishCancelled(stage, startedAt);
    if (stage.pre.verdict === "deny" || decision !== "approve")
      return finishBlockedPre(stage, decision);
    return finishAdmitted(stage, outcome, startedAt);
  }

  async function runExisting<T extends PlainValue>(
    request: ExecutionRequest,
    body: () => Promise<T>,
  ): Promise<ExecutionResult> {
    registeredKind(request);

    const pre = await decide(request, "pre", request.intent);
    const refusal = preRefusal(pre, true);
    if (refusal !== undefined) return refusal;

    return applyPostPolicy(request, clonePlainValue(await body()));
  }

  const runAttempts = createAttemptRunner(
    options,
    { appendIntent, appendResult, appendFailure },
    (request, parent) =>
      decide({ kind: "llm", ...request }, "pre", request.intent, parent.action.id),
    (request, intent, admission) =>
      awaitApproval(
        {
          id: intent.action.id,
          ...approvalIdentity(),
          callId: intent.action.id,
          inputHash: canonicalDigest(request.intent),
          generation: admission.generation,
          revision: admission.receipt.revision,
          policyDecisionId: admission.receipt.action.id,
          intent: request.intent,
        },
        options.signal ?? ambientSignal(),
        { effect: request.effect },
      ),
  );

  function originalRequest(id: string): SessionTransition.Request | undefined {
    return findSessionRequest(options.ledger.actions?.() ?? [], id);
  }

  function registeredKind(request: ExecutionRequest): LedgerAction.Kind {
    if (!kinds.has(request.kind)) throw new UnregisteredExecutionKindError(request.kind);
    return request.kind as LedgerAction.Kind;
  }

  async function finishRun(
    request: ExecutionRequest,
    kind: LedgerAction.Kind,
    intentId: string,
    startedAt: number | undefined,
    resultValue: PlainValue,
    outcome: PostOutcome,
  ): Promise<ExecutionResult> {
    await appendResult(
      { kind, op: request.op },
      intentId,
      { ...resultEffect(request, resultValue, outcome), ...projectToolResult(request, outcome) },
      revertDataFor(request, outcome),
    );
    publishToolTerminal(request, startedAt, terminalStatus(outcome));
    return outcome;
  }

  async function applyPostPolicy(
    request: ExecutionRequest,
    resultValue: PlainValue,
  ): Promise<PostOutcome> {
    const post = await decide(request, "post", {
      intent: request.intent,
      effect: request.effect,
      result: resultValue,
    });
    return settlePost(request, post, resultValue);
  }

  const judgeStop = createStopJudge(
    options,
    (op, value) => decide({ kind: "turn", op, intent: value, effect: {} }, "post", value),
    commit,
  );
  return {
    run,
    runAttempts,
    runExisting,
    runBatch,
    approvals,
    judgeStop,
    recover: recovery.recover,
  };
}

function resultEffect(
  request: ExecutionRequest,
  resultValue: PlainValue,
  outcome: PostOutcome,
): PlainObject {
  if (outcome.terminal === "blocked_post") {
    return {
      phase: "result",
      terminal: outcome.terminal,
      disposition: outcome.disposition,
      reason: outcome.reason,
      effect: request.effect,
      resultHash: canonicalDigest(resultValue),
    };
  }
  return {
    phase: "result",
    terminal: outcome.terminal,
    effect: request.effect,
    resultHash: canonicalDigest(outcome.value),
    ...(RESULT_ECHO_KINDS.has(request.kind) ? { result: outcome.value } : {}),
    ...(request.toolObservation === undefined ? {} : { callId: request.toolObservation.callId }),
  };
}

function revertDataFor(request: ExecutionRequest, outcome: PostOutcome) {
  return outcome.terminal === "executed" ? request.revertData?.() : undefined;
}

function terminalStatus(outcome: PostOutcome): ToolObservationStatus {
  return outcome.terminal === "blocked_post" ? "error" : toolObservationStatus(outcome.value);
}

async function settlePost(
  request: ExecutionRequest,
  post: PolicyEvaluation,
  resultValue: PlainValue,
): Promise<PostOutcome> {
  const transformed = resultFromEvaluation(post, resultValue);
  if (!blocks(post) && transformed.ok) return { terminal: "executed", value: transformed.value };
  return blockPost(request, transformed.ok ? deniedReason(post) : "invalid_output");
}

async function blockPost(request: ExecutionRequest, reason: string): Promise<PostOutcome> {
  if (request.revert === undefined)
    return { terminal: "blocked_post", disposition: "irreversible", reason };
  await request.revert();
  return { terminal: "blocked_post", disposition: "reverted", reason };
}

function projectToolResult(request: ExecutionRequest, outcome: ExecutionBatchResult): PlainObject {
  return request.toolResult === undefined ? {} : { toolResult: request.toolResult(outcome) };
}

function blocks(decision: PolicyEvaluation): boolean {
  return decision.verdict === "deny" || decision.verdict === "require_approval";
}

function preRefusal(
  decision: PolicyEvaluation,
  rejectTransform: boolean,
): Extract<ExecutionResult, { readonly terminal: "blocked_pre" }> | undefined {
  if (blocks(decision)) return { terminal: "blocked_pre", reason: deniedReason(decision) };
  if (rejectTransform && decision.verdict === "transform") {
    return { terminal: "blocked_pre", reason: "invalid_input" };
  }
  return undefined;
}

function clonePlainValue(value: PlainValue): PlainValue {
  return PlainValueSchema.parse(structuredClone(value));
}

function plainRecord(value: PlainValue): PlainObject | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return value;
}

function resultFromEvaluation(
  evaluation: PolicyEvaluation,
  fallback: PlainValue,
): { readonly ok: true; readonly value: PlainValue } | { readonly ok: false } {
  if (evaluation.verdict !== "transform") return { ok: true, value: fallback };
  const result = plainRecord(evaluation.value)?.result;
  if (result === undefined) return { ok: false };
  return { ok: true, value: result };
}

function toolObservationStatus(value: PlainValue): ToolObservationStatus {
  const status = plainRecord(value)?.status;
  if (status === "success" || status === "timed_out") return status;
  return "error";
}
