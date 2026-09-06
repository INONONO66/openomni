import type { LedgerAction, PlainValue } from "@openomni/protocol";
import { canonicalDigest } from "@openomni/protocol";
import type { PolicyEvaluation, PolicyEvaluationInput } from "@openomni/policy";

import { runWaveBodies, waveBodyScope, type WaveControl } from "./core/execution/tool-wave";

const CORE_KINDS = new Set(["prompt", "turn", "llm", "tool", "compaction"]);
import { createExecutionRecord, type ToolObservationStatus } from "./executor-record";

export class UnregisteredExecutionKindError extends Error {
  readonly code = "unregistered_execution_kind";

  constructor(readonly kind: string) {
    super(`unregistered execution kind: ${kind}`);
    this.name = "UnregisteredExecutionKindError";
  }
}

import type {
  AttemptRequest,
  DurableExecutor,
  ExecutionBatchItem,
  ExecutionBatchResult,
  ExecutionRequest,
  ExecutionResult,
  ExecutorOptions,
} from "./executor-contract";
import { createExecutionApprovals } from "./executor-approval";
export { ExecutionApprovalError } from "./executor-contract";
export type {
  DurableExecutor,
  ExecutionLedger,
  Executor,
  ExecutionRequest,
  ExecutionApprovals,
  ExecutionApprovalRequest,
  ExecutionBatchResult,
  ExecutorOptions,
} from "./executor-contract";

export function createExecutor(options: ExecutorOptions): DurableExecutor {
  const {
    commit,
    appendFailure,
    appendIntent,
    appendResult,
    publishToolStarted,
    publishToolTerminal,
  } = createExecutionRecord(options);
  const { approvals, awaitApproval } = createExecutionApprovals(options, commit);
  const kinds = new Set([
    ...CORE_KINDS,
    ...(options.extensionKinds ?? []).map((registration) => registration.kind),
  ]);

  async function decide(
    request: ExecutionRequest,
    phase: "pre" | "post",
    value: PlainValue,
  ): Promise<PolicyEvaluation & { readonly receipt: LedgerAction.Receipt }> {
    // Compaction is the existing turn.post/compaction policy operation,
    // even though its durable evidence has the dedicated compaction kind.
    const point =
      request.kind === "compaction"
        ? { kind: "turn", phase: "post" as const, op: "compaction" }
        : { kind: request.kind, phase, op: request.op };
    const input: PolicyEvaluationInput = {
      ...point,
      role: options.identity.role,
      sessionId: options.identity.sessionId,
      value,
    };
    const decision = options.policy.evaluate(input);
    const receipt = await commit({
      id: options.entropy(),
      parentId: options.identity.parentActionId,
      sessionId: options.identity.sessionId,
      kind: "policy.decision",
      intent: {
        encodingVersion: 1,
        value: {
          hook: `${point.kind}.${point.phase}`,
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
    const results = await runBatch([{ request, body }], {
      signal: waveBodyScope.getStore()?.signal ?? new AbortController().signal,
    });
    const result = results[0];
    if (result === undefined) throw new Error("single execution lost its result");
    if (result.terminal === "failed") throw result.error;
    if (result.terminal === "cancelled")
      throw new DOMException("execution cancelled", "AbortError");
    return result;
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
      return await executeBatch(items, {
        signal,
        // A captured executor keeps its turn's owner outside the ambient scope.
        retain: options.retainEffect ?? inherited?.retain ?? control.retain,
      });
    } finally {
      controller.abort();
    }
  }

  async function executeBatch(
    items: readonly ExecutionBatchItem[],
    control: WaveControl,
  ): Promise<readonly ExecutionBatchResult[]> {
    waveBodyScope.getStore()?.signal.throwIfAborted();
    // Salvaged staged-pre algorithm: every decision precedes every intent/body.
    const stages: {
      item: ExecutionBatchItem;
      request: ExecutionRequest;
      kind: LedgerAction.Kind;
      pre: Awaited<ReturnType<typeof decide>>;
    }[] = [];
    for (const item of items) {
      const request = { ...item.request, intent: clonePlainValue(item.request.intent) };
      const kind = registeredKind(request);
      const pre = await decide(request, "pre", request.intent);
      stages.push({ item, request, kind, pre });
    }
    const admitted: ((typeof stages)[number] & { intent: LedgerAction.Receipt | undefined })[] = [];
    for (const stage of stages) {
      const intent =
        stage.pre.verdict === "deny"
          ? undefined
          : await appendIntent({
              parentId: options.identity.parentActionId,
              kind: stage.kind,
              op: stage.request.op,
              value: stage.request.intent,
            });
      admitted.push({ ...stage, intent });
    }
    const decisions = await Promise.all(
      admitted.map(async (stage) => {
        if (stage.pre.verdict !== "require_approval" || stage.intent === undefined)
          return "approve" as const;
        return awaitApproval(
          {
            id: stage.intent.action.id,
            sessionId: options.identity.sessionId,
            turnId: options.identity.turnId ?? options.identity.parentActionId,
            ...(options.identity.toolsHash === undefined
              ? {}
              : { toolsHash: options.identity.toolsHash }),
            ...(options.identity.toolsGeneration === undefined
              ? {}
              : { toolsGeneration: options.identity.toolsGeneration }),
            callId: stage.request.toolObservation?.callId ?? stage.intent.action.id,
            inputHash: canonicalDigest(stage.request.intent),
            generation: stage.pre.generation,
            revision: stage.pre.receipt.revision,
            policyDecisionId: stage.pre.receipt.action.id,
            intent: stage.request.intent,
          },
          control.signal,
        );
      }),
    );
    const started = new Map<number, number | undefined>();
    const outcomes = await runWaveBodies(
      admitted.map((stage, index) => ({
        ...(stage.item.sequential ? { sequential: true as const } : {}),
        async run() {
          if (
            stage.pre.verdict === "deny" ||
            decisions[index] !== "approve" ||
            stage.intent === undefined
          )
            return null;
          started.set(index, publishToolStarted(stage.request));
          return stage.item.body(stage.intent);
        },
      })),
      control,
    );
    const results: ExecutionBatchResult[] = [];
    for (const [index, stage] of admitted.entries()) {
      const outcome = outcomes[index];
      const intent = stage.intent;
      if (outcome === undefined) throw new Error("wave lost positional result");
      if (outcome.status === "cancelled") {
        if (intent !== undefined)
          await appendResult({ kind: stage.kind, op: stage.request.op }, intent.action.id, {
            phase: "result",
            terminal: "cancelled",
            callId: stage.request.toolObservation?.callId ?? null,
          });
        publishToolTerminal(stage.request, started.get(index), "error");
        results.push({ terminal: "cancelled" });
      } else if (stage.pre.verdict === "deny" || decisions[index] !== "approve") {
        const reason =
          stage.pre.verdict === "deny"
            ? (stage.pre.reason ?? "denied")
            : decisions[index] === "timeout"
              ? "approval_timeout"
              : "approval_refused";
        if (intent !== undefined)
          await appendResult({ kind: stage.kind, op: stage.request.op }, intent.action.id, {
            phase: "result",
            terminal: "blocked_pre",
            reason,
            callId: stage.request.toolObservation?.callId ?? null,
          });
        results.push({ terminal: "blocked_pre", reason });
      } else if (intent === undefined) throw new Error("wave lost admitted intent");
      else if (outcome.status === "rejected") {
        await appendFailure(
          { kind: stage.kind, op: stage.request.op },
          intent.action.id,
          stage.request.effect,
          outcome.error,
          stage.request.toolObservation?.callId,
        );
        publishToolTerminal(stage.request, started.get(index), "error");
        results.push({ terminal: "failed", error: outcome.error });
      } else {
        const value = clonePlainValue(outcome.value);
        const post = await applyPostPolicy(stage.request, value);
        results.push(
          await finishRun(
            stage.request,
            stage.kind,
            intent.action.id,
            started.get(index),
            value,
            post,
          ),
        );
      }
    }
    return results;
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

  async function runAttempt<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    request: AttemptRequest,
    body: () => Promise<T>,
  ): Promise<T> {
    const intent = await appendIntent({
      kind: "attempt",
      op: request.op,
      parentId: parent.action.id,
      value: request.intent,
    });
    const outcome = await body().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (caught) => ({ status: "rejected" as const, caught }),
    );
    if (outcome.status === "rejected") {
      await appendFailure(
        { kind: "attempt", op: request.op },
        intent.action.id,
        request.effect,
        outcome.caught,
      );
      throw outcome.caught;
    }
    await appendResult({ kind: "attempt", op: request.op }, intent.action.id, {
      phase: "result",
      terminal: "executed",
      effect: request.effect,
    });
    return outcome.value;
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
    outcome: Exclude<ExecutionResult, { readonly terminal: "blocked_pre" }>,
  ): Promise<ExecutionResult> {
    const effect: PlainValue =
      outcome.terminal === "blocked_post"
        ? {
            phase: "result",
            terminal: outcome.terminal,
            disposition: outcome.disposition,
            reason: outcome.reason,
            effect: request.effect,
            resultHash: canonicalDigest(resultValue),
          }
        : {
            phase: "result",
            terminal: outcome.terminal,
            effect: request.effect,
            resultHash: canonicalDigest(outcome.value),
            ...(request.kind === "compaction" || request.kind === "tool"
              ? { result: outcome.value }
              : {}),
            ...(request.toolObservation ? { callId: request.toolObservation.callId } : {}),
          };
    await appendResult(
      { kind, op: request.op },
      intentId,
      effect,
      outcome.terminal === "executed" ? request.revertData?.() : undefined,
    );
    const status =
      outcome.terminal === "blocked_post" ? "error" : toolObservationStatus(outcome.value);
    publishToolTerminal(request, startedAt, status);
    return outcome;
  }

  async function applyPostPolicy(
    request: ExecutionRequest,
    resultValue: PlainValue,
  ): Promise<Exclude<ExecutionResult, { readonly terminal: "blocked_pre" }>> {
    const post = await decide(request, "post", {
      intent: request.intent,
      effect: request.effect,
      result: resultValue,
    });
    const transformed = resultFromEvaluation(post, resultValue);
    if (!blocks(post) && transformed.ok) {
      return { terminal: "executed", value: transformed.value };
    }
    const reason = transformed.ok ? (post.reason ?? "denied") : "invalid_output";
    const disposition = request.revert === undefined ? "irreversible" : "reverted";
    if (request.revert !== undefined) await request.revert();
    return { terminal: "blocked_post", disposition, reason };
  }

  return { run, runAttempt, runExisting, runBatch, approvals };
}

function blocks(decision: PolicyEvaluation): boolean {
  return decision.verdict === "deny" || decision.verdict === "require_approval";
}

function preRefusal(
  decision: PolicyEvaluation,
  rejectTransform: boolean,
): Extract<ExecutionResult, { readonly terminal: "blocked_pre" }> | undefined {
  if (blocks(decision)) return { terminal: "blocked_pre", reason: decision.reason ?? "denied" };
  if (rejectTransform && decision.verdict === "transform") {
    return { terminal: "blocked_pre", reason: "invalid_input" };
  }
  return undefined;
}

function clonePlainValue(value: PlainValue): PlainValue {
  return JSON.parse(JSON.stringify(value)) as PlainValue;
}

function resultFromEvaluation(
  evaluation: PolicyEvaluation,
  fallback: PlainValue,
): { readonly ok: true; readonly value: PlainValue } | { readonly ok: false } {
  if (evaluation.verdict !== "transform") return { ok: true, value: fallback };
  const evaluated = evaluation.value;
  if (
    evaluated === null ||
    Array.isArray(evaluated) ||
    typeof evaluated !== "object" ||
    !("result" in evaluated)
  ) {
    return { ok: false };
  }
  return { ok: true, value: evaluated.result };
}

function toolObservationStatus(value: PlainValue): ToolObservationStatus {
  if (value === null || Array.isArray(value) || typeof value !== "object") return "error";
  if (value.status === "success" || value.status === "timed_out") return value.status;
  return "error";
}
