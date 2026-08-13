import {
  IngressEvent,
  type Execution,
  type Ingress,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, WorkItemAttemptRun, WorkItemStore } from "@openomni/session";
import { allocateWorkerSpawnAttempt } from "../dispatch/handlers/worker-work-item";
import type { ResidentRuntime } from "../resident/runtime";
import type { CoordinatorLike } from "./coordinator-like";
import { SessionBridge } from "./session-bridge";
import { resolveTarget } from "./target";

/**
 * THE canonical inbound payload-text parser: a string payload is the text, a
 * `{ text: string }` envelope unwraps, anything else round-trips through
 * JSON (nullish and non-serializable payloads fail safe to ""). Ingress owns
 * it — the payload shape is minted at the ingress boundary — and dispatch
 * imports it rather than keeping a drifted copy.
 */
export function extractText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (
    payload &&
    typeof payload === "object" &&
    "text" in payload &&
    typeof (payload as { text?: unknown }).text === "string"
  ) {
    return (payload as { text: string }).text;
  }
  if (payload === null || payload === undefined) return "";
  return JSON.stringify(payload) ?? "";
}

/**
 * The single ingress dispatch lifecycle: payload extraction, mode events,
 * durable attempt-run bookkeeping (#510 D2b: WorkItem attempt facts, never
 * worker_run_state rows), and the resident/direct handlers that consume them.
 */
export namespace IngressHandlers {
  export interface HandlerContext {
    sessionId: string;
    event: Ingress.ResolvedInboundEvent;
    coordinator?: CoordinatorLike;
    residentRuntime?: Pick<ResidentRuntime, "run">;
    traceContext?: TraceContextProtocol.Type;
  }

  // ---- observe-only ingress lifecycle events ----

  function summarizeTarget(event: Ingress.ResolvedInboundEvent): string | undefined {
    return resolveTarget(event).kind;
  }

  function publishModeDetected(ctx: HandlerContext, target: string | undefined): void {
    if (!ctx.traceContext) return;
    Bus.publish(IngressEvent.ModeDetected, {
      traceId: ctx.traceContext.traceId,
      sessionId: ctx.sessionId,
      mode: ctx.event.mode,
      ...(target ? { target } : {}),
      time: Date.now(),
    });
  }

  function publishCompleted(ctx: HandlerContext, target: string | undefined, start: number): void {
    if (!ctx.traceContext) return;
    Bus.publish(IngressEvent.Completed, {
      traceId: ctx.traceContext.traceId,
      sessionId: ctx.sessionId,
      mode: ctx.event.mode,
      ...(target ? { target } : {}),
      durationMs: Date.now() - start,
      time: Date.now(),
    });
  }

  function publishFailed(
    ctx: HandlerContext,
    target: string | undefined,
    start: number,
    error: unknown,
  ): void {
    if (!ctx.traceContext) return;
    const message = error instanceof Error ? error.message : String(error);
    Bus.publish(IngressEvent.Failed, {
      traceId: ctx.traceContext.traceId,
      sessionId: ctx.sessionId,
      mode: ctx.event.mode,
      ...(target ? { target } : {}),
      durationMs: Date.now() - start,
      error: message,
      time: Date.now(),
    });
  }

  // ---- durable run lifecycle (#510 D2b: WorkItem attempt facts) ----

  /**
   * #510 D2b — the durable run record for a worker-targeted ingress dispatch
   * is a WorkItem with an allocated attempt on the `work:<hash>` owner
   * stream. NO worker_run_state row is written: the attempt identity fact is
   * appended before the executor acts, and the terminal outcome (endedAt,
   * error — the fields that used to sit in the in-memory runExtras map)
   * lands as the `work_item.attempt_finished` fact.
   */
  async function createDurableAttemptRun(
    ctx: HandlerContext,
    request: Execution.Request,
  ): Promise<void> {
    const prompt = extractText(ctx.event.payload);
    const parentSessionId =
      typeof ctx.event.meta?.actor === "object" && ctx.event.meta.actor !== null
        ? String((ctx.event.meta.actor as Record<string, unknown>).sessionId ?? "") || undefined
        : undefined;
    const workItem = await WorkItemStore.create({
      name: `Ingress worker ${request.agentName ?? "worker"}`,
      sourceMessageId: ctx.event.id,
      sourceChannel: ctx.event.surface,
      intent: "worker.dispatch",
      // The content fingerprint's canonical work input rejects the empty
      // string; an empty ingress payload is declared as such.
      goal: prompt || "(empty ingress payload)",
      assigneeId: request.agentName,
      sessionId: ctx.sessionId,
      originSessionId: parentSessionId,
      workSessionId: ctx.sessionId,
      workerRunId: request.runId,
      executorKind: "internal_chat_agent",
      // Ingress dispatch carries no caller acceptance criteria; the run's
      // terminal truth is its attempt outcome, not a completion admission.
      acceptanceCriteria: ["the dispatched worker run reaches a terminal attempt outcome"],
    });
    await WorkItemStore.start(workItem.hash);
    await allocateWorkerSpawnAttempt(
      workItem.hash,
      prompt || "(empty ingress payload)",
      "internal_chat_agent",
      {
        model: ctx.event.agent.model,
        policyPlan: ctx.event.agent.policyPlan,
        workspaceRoot: ctx.event.agent.toolConfig?.workspaceRoot,
      },
    );
  }

  async function finishCoordinatorDispatch(
    ctx: HandlerContext,
    request: Execution.Request,
    coordinatorResult: Execution.Result,
  ): Promise<void> {
    await WorkItemAttemptRun.finish(ctx.sessionId, request.runId, coordinatorResult.status, {
      endedAt: Date.now(),
      ...(coordinatorResult.status !== "succeeded" && coordinatorResult.error
        ? { error: coordinatorResult.error }
        : {}),
    });
  }

  async function markDispatchThrown(
    ctx: HandlerContext,
    request: Execution.Request,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    // finish() is a no-op receipt (false) when the run already ended.
    await WorkItemAttemptRun.finish(ctx.sessionId, request.runId, "interrupted", {
      endedAt: Date.now(),
      error: message,
    });
  }

  // ---- worker cancel / delivery / background dispatch ----

  function isBackgroundWorkerIngress(ctx: HandlerContext): boolean {
    return (ctx.event.runtime as { background?: unknown } | undefined)?.background === true;
  }

  async function handleCancelRequest(
    ctx: HandlerContext,
  ): Promise<Ingress.IngressResult | undefined> {
    if (ctx.event.runtime?.lifecycle !== "stopping") return undefined;
    if (!ctx.coordinator?.cancelRun) {
      throw new Error("coordinator cancellation is required for worker cancellation");
    }

    const requestedRunId = ctx.event.runtime?.runId;
    const active = WorkItemAttemptRun.listActive(ctx.sessionId).filter(
      (run) => !requestedRunId || run.runId === requestedRunId,
    );
    const results = await Promise.all(
      active.map(async (run) => {
        const result = await ctx.coordinator?.cancelRun?.(run.runId);
        const cancelled =
          result !== null &&
          typeof result === "object" &&
          (result as { cancelled?: unknown }).cancelled === true;
        if (cancelled) {
          await WorkItemAttemptRun.finish(ctx.sessionId, run.runId, "cancelled", {
            endedAt: Date.now(),
          });
        }
        return { runId: run.runId, cancelled, result };
      }),
    );
    const output = JSON.stringify({
      cancelled: results.filter((run) => run.cancelled).length,
      requested: results.length,
      runs: results,
    });
    SessionBridge.storeDirectResult(
      requireTraceId(ctx),
      ctx.sessionId,
      output,
      ctx.event.agent.model,
    );
    return {
      mode: ctx.event.mode,
      target: resolveTarget(ctx.event),
      sessionId: ctx.sessionId,
      result: { output, finishReason: "cancelled" },
    };
  }

  async function handleWorkerDelivery(
    ctx: HandlerContext,
  ): Promise<Ingress.IngressResult | undefined> {
    const target = resolveTarget(ctx.event);
    if (target.kind !== "worker" || !ctx.coordinator?.deliverMessage) return undefined;

    const raw = await ctx.coordinator.deliverMessage(
      ctx.sessionId,
      extractText(ctx.event.payload),
      ctx.event.runtime?.runId,
    );
    const accepted =
      raw !== null && typeof raw === "object" && (raw as { accepted?: unknown }).accepted === true;
    if (!accepted) return undefined;

    const output = JSON.stringify({
      delivered: true,
      sessionId: ctx.sessionId,
      runId: ctx.event.runtime?.runId,
    });
    SessionBridge.storeDirectResult(
      requireTraceId(ctx),
      ctx.sessionId,
      output,
      ctx.event.agent.model,
    );
    return {
      mode: ctx.event.mode,
      target,
      sessionId: ctx.sessionId,
      result: { output, finishReason: "delivered" },
    };
  }

  function startBackgroundWorkerDispatch(
    ctx: HandlerContext,
    request: Execution.Request,
    target: string | undefined,
    start: number,
  ): void {
    if (!ctx.coordinator) throw new Error("coordinator is required for worker-targeted ingress");
    const coordinator = ctx.coordinator;

    void (async () => {
      try {
        const result = await coordinator.dispatch(ctx.sessionId, request);
        await finishCoordinatorDispatch(ctx, request, result);
        if (result.output) {
          SessionBridge.storeDirectResult(
            requireTraceId(ctx),
            ctx.sessionId,
            result.output,
            ctx.event.agent.model,
          );
        }
        if (result.status === "succeeded" || result.status === "cancelled") {
          publishCompleted(ctx, target, start);
          return;
        }
        publishFailed(ctx, target, start, result.error ?? result.status);
      } catch (error) {
        publishFailed(ctx, target, start, error);
        await markDispatchThrown(ctx, request, error);
      }
    })();
  }

  // ---- public handlers ----

  export function buildExecutionRequest(ctx: HandlerContext): Execution.Request {
    return {
      runId: crypto.randomUUID(),
      sessionId: ctx.sessionId,
      mode: "direct",
      prompt: extractText(ctx.event.payload),
      model: ctx.event.agent.model,
      systemPrompt: ctx.event.agent.systemPrompt,
      tools: ctx.event.agent.tools,
      toolConfig: ctx.event.agent.toolConfig,
      permissions: ctx.event.agent.permissions,
      credentials: undefined,
      budget: ctx.event.agent.budget,
      workspaceRoot: ctx.event.agent.toolConfig?.workspaceRoot,
      policyPlan: ctx.event.agent.policyPlan,
      providerOptions: (ctx.event.agent as { providerOptions?: Record<string, unknown> })
        .providerOptions,
      traceId: requireTraceId(ctx),
      agentName:
        typeof ctx.event.meta?.agentName === "string" ? ctx.event.meta.agentName : undefined,
    };
  }

  export async function handleResident(ctx: HandlerContext): Promise<Ingress.IngressResult> {
    if (!ctx.residentRuntime) {
      throw new Error("resident runtime is required");
    }

    publishModeDetected(ctx, "resident");

    // Bound once here: `residentRuntime.run` refuses without it, so re-asking
    // below would be a second enforcement of a condition already settled.
    const traceId = requireTraceId(ctx);
    const residentResult = await ctx.residentRuntime.run({
      sessionId: ctx.sessionId,
      event: ctx.event,
      traceContext: ctx.traceContext,
      signal: (ctx.event.runtime as { signal?: AbortSignal } | undefined)?.signal,
    });
    const output = residentResult.output;
    SessionBridge.storeDirectResult(traceId, ctx.sessionId, output, ctx.event.agent.model);

    return {
      mode: ctx.event.mode,
      target: resolveTarget(ctx.event),
      sessionId: ctx.sessionId,
      result: {
        output,
        finishReason: residentResult.finishReason,
      },
    };
  }

  export async function handleDirect(ctx: HandlerContext): Promise<Ingress.IngressResult> {
    const target = summarizeTarget(ctx.event);
    publishModeDetected(ctx, target);

    const cancelResult = await handleCancelRequest(ctx);
    if (cancelResult) return cancelResult;

    const start = Date.now();
    const deliveryResult = await handleWorkerDelivery(ctx);
    if (deliveryResult) {
      publishCompleted(ctx, target, start);
      return deliveryResult;
    }

    const request = buildExecutionRequest(ctx);
    if (!ctx.coordinator) throw new Error("coordinator is required for worker-targeted ingress");
    await createDurableAttemptRun(ctx, request);
    if (isBackgroundWorkerIngress(ctx)) {
      startBackgroundWorkerDispatch(ctx, request, target, start);
      const output = JSON.stringify({
        accepted: true,
        status: "started",
        runId: request.runId,
        sessionId: ctx.sessionId,
      });
      SessionBridge.storeDirectResult(
        requireTraceId(ctx),
        ctx.sessionId,
        output,
        ctx.event.agent.model,
      );
      return {
        mode: ctx.event.mode,
        target: resolveTarget(ctx.event),
        sessionId: ctx.sessionId,
        result: { output, finishReason: "background" },
      };
    }
    let coordinatorResult: Execution.Result;
    try {
      coordinatorResult = await ctx.coordinator.dispatch(ctx.sessionId, request);
      await finishCoordinatorDispatch(ctx, request, coordinatorResult);
      if (coordinatorResult.status !== "succeeded") {
        if (coordinatorResult.status === "cancelled") {
          const output = coordinatorResult.output ?? coordinatorResult.error ?? "cancelled";
          SessionBridge.storeDirectResult(
            requireTraceId(ctx),
            ctx.sessionId,
            output,
            ctx.event.agent.model,
          );
          publishCompleted(ctx, target, start);
          return {
            mode: ctx.event.mode,
            target: resolveTarget(ctx.event),
            sessionId: ctx.sessionId,
            result: {
              output,
              finishReason: coordinatorResult.finishReason ?? "cancelled",
            },
          };
        }
        throw new Error(
          `Coordinator dispatch failed: ${coordinatorResult.error ?? coordinatorResult.status}`,
        );
      }
    } catch (error) {
      publishFailed(ctx, target, start, error);
      await markDispatchThrown(ctx, request, error);
      throw error;
    }
    const output = coordinatorResult.output ?? "";
    SessionBridge.storeDirectResult(
      requireTraceId(ctx),
      ctx.sessionId,
      output,
      ctx.event.agent.model,
    );

    publishCompleted(ctx, target, start);

    return {
      mode: ctx.event.mode,
      target: resolveTarget(ctx.event),
      sessionId: ctx.sessionId,
      result: {
        output,
        finishReason: coordinatorResult.finishReason ?? "stop",
      },
    };
  }
}

/**
 * The trace a writeback is recorded under. `traceContext` is optional on the
 * handler context because not every ingress path establishes one yet; a
 * writeback without a trace would land in the journal attributed to nothing,
 * so it is refused rather than filed under the session id.
 */
function requireTraceId(ctx: { readonly traceContext?: TraceContextProtocol.Type }): string {
  const traceId = ctx.traceContext?.traceId;
  if (traceId === undefined) throw new Error("ingress writeback requires a trace context");
  return traceId;
}
