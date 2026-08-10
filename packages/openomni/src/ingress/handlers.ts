import { PolicyEngine, type PolicyDecision } from "@openomni/policy";
import type { PolicyRegistration } from "@openomni/agent";
import {
  IngressEvent,
  PolicyDecision as Decision,
  type Execution,
  type Ingress,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, WorkerRun } from "@openomni/session";
import type { ResidentRuntime } from "../resident/runtime";
import type { CoordinatorLike } from "./coordinator-like";
import { SessionBridge } from "./session-bridge";
import { resolveTarget } from "./target";

/**
 * The single ingress dispatch lifecycle: payload extraction, mode events,
 * writeback policy, durable worker-run bookkeeping, and the resident/direct
 * handlers that consume them.
 */
export namespace IngressHandlers {
  export interface HandlerContext {
    sessionId: string;
    event: Ingress.ResolvedInboundEvent;
    coordinator?: CoordinatorLike;
    residentRuntime?: Pick<ResidentRuntime, "run">;
    traceContext?: TraceContextProtocol.Type;
    policies?: readonly PolicyRegistration[];
    onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
  }

  // ---- inbound payload text ----

  function extractPrompt(payload: unknown): string {
    if (typeof payload === "string") return payload;
    if (
      payload &&
      typeof payload === "object" &&
      "text" in payload &&
      typeof (payload as { text: unknown }).text === "string"
    ) {
      return (payload as { text: string }).text;
    }
    return JSON.stringify(payload);
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

  // ---- writeback.commit policy gate ----

  const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  async function dispatchWritebackCommit(ctx: HandlerContext, output: string): Promise<string> {
    if (!ctx.policies?.length) return output;

    const engine = PolicyEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onPolicyDecision,
    });
    for (const reg of ctx.policies) {
      engine.register(reg);
    }

    const decision = await engine.dispatch("writeback.commit", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 0,
      labels: [
        { value: `surface.${ctx.event.surface}`, source: "system" },
        { value: `target.${resolveTarget(ctx.event).kind}`, source: "system" },
      ],
      toolInput: {
        sessionId: ctx.sessionId,
        mode: ctx.event.mode,
        target: resolveTarget(ctx.event).kind,
        surface: ctx.event.surface,
        output,
      },
      traceContext: ctx.traceContext,
    });

    return resolveWritebackDecision(decision, output);
  }

  function resolveWritebackDecision(decision: Decision, output: string): string {
    if (Decision.isBlocking(decision)) {
      throw new Error(Decision.reason(decision, "writeback.commit policy denied"));
    }
    const suppress = decision.effects.find((effect) => effect.type === "writeback.suppress");
    if (suppress?.type === "writeback.suppress") {
      throw new Error(suppress.reason ?? "writeback.commit policy suppressed output");
    }
    const rewrite = decision.effects.find((effect) => effect.type === "writeback.rewrite");
    return rewrite?.type === "writeback.rewrite" ? rewrite.output : output;
  }

  // ---- durable worker-run lifecycle ----

  type TerminalWorkerRunStatus = "succeeded" | "failed" | "cancelled" | "interrupted";

  const terminalWorkerRunStatuses = new Set<string>([
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]);

  async function createDurableWorkerRun(
    ctx: HandlerContext,
    request: Execution.Request,
  ): Promise<void> {
    const prompt = extractPrompt(ctx.event.payload);
    await WorkerRun.create(ctx.sessionId, {
      runId: request.runId,
      title: prompt.slice(0, 80) || "Worker run",
      prompt,
      agentName: request.agentName ?? "worker",
      parentSessionId:
        typeof ctx.event.meta?.actor === "object" && ctx.event.meta.actor !== null
          ? String((ctx.event.meta.actor as Record<string, unknown>).sessionId ?? "") || undefined
          : undefined,
    });
    await WorkerRun.updateStatus(ctx.sessionId, request.runId, "starting");
  }

  async function completeDurableWorkerRun(
    ctx: HandlerContext,
    request: Execution.Request,
    status: TerminalWorkerRunStatus,
    error?: string,
  ): Promise<void> {
    const existing = await WorkerRun.get(ctx.sessionId, request.runId);
    if (!existing) return;
    if (terminalWorkerRunStatuses.has(existing.status)) return;
    if (existing.status === "starting" && status === "succeeded") {
      await WorkerRun.updateStatus(ctx.sessionId, request.runId, "running");
    }
    await WorkerRun.updateStatus(ctx.sessionId, request.runId, status, {
      endedAt: Date.now(),
      ...(error ? { error } : {}),
    });
  }

  async function finishCoordinatorDispatch(
    ctx: HandlerContext,
    request: Execution.Request,
    coordinatorResult: Execution.Result,
  ): Promise<void> {
    if (coordinatorResult.status !== "succeeded") {
      await completeDurableWorkerRun(
        ctx,
        request,
        coordinatorResult.status,
        coordinatorResult.error,
      );
      return;
    }
    await completeDurableWorkerRun(ctx, request, "succeeded");
  }

  async function markDispatchThrown(
    ctx: HandlerContext,
    request: Execution.Request,
    error: unknown,
  ): Promise<void> {
    const existing = await WorkerRun.get(ctx.sessionId, request.runId);
    if (!existing || terminalWorkerRunStatuses.has(existing.status)) return;
    const message = error instanceof Error ? error.message : String(error);
    await completeDurableWorkerRun(ctx, request, "interrupted", message);
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
    const active = (await WorkerRun.listBySession(ctx.sessionId)).filter(
      (run) =>
        ["starting", "running", "waiting_input"].includes(run.status) &&
        (!requestedRunId || run.runId === requestedRunId),
    );
    const results = await Promise.all(
      active.map(async (run) => {
        const result = await ctx.coordinator?.cancelRun?.(run.runId);
        const cancelled =
          result !== null &&
          typeof result === "object" &&
          (result as { cancelled?: unknown }).cancelled === true;
        if (cancelled) {
          await WorkerRun.updateStatus(ctx.sessionId, run.runId, "cancelled", {
            endedAt: Date.now(),
          });
        }
        return { runId: run.runId, cancelled, result };
      }),
    );
    const output = await dispatchWritebackCommit(
      ctx,
      JSON.stringify({
        cancelled: results.filter((run) => run.cancelled).length,
        requested: results.length,
        runs: results,
      }),
    );
    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
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
      extractPrompt(ctx.event.payload),
      ctx.event.runtime?.runId,
    );
    const accepted =
      raw !== null && typeof raw === "object" && (raw as { accepted?: unknown }).accepted === true;
    if (!accepted) return undefined;

    const output = await dispatchWritebackCommit(
      ctx,
      JSON.stringify({
        delivered: true,
        sessionId: ctx.sessionId,
        runId: ctx.event.runtime?.runId,
      }),
    );
    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
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
          SessionBridge.storeDirectResult(ctx.sessionId, result.output, ctx.event.agent.model);
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
      prompt: extractPrompt(ctx.event.payload),
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
      traceId: ctx.traceContext?.traceId,
      agentName:
        typeof ctx.event.meta?.agentName === "string" ? ctx.event.meta.agentName : undefined,
    };
  }

  export async function handleResident(ctx: HandlerContext): Promise<Ingress.IngressResult> {
    if (!ctx.residentRuntime) {
      throw new Error("resident runtime is required");
    }

    publishModeDetected(ctx, "resident");

    const residentResult = await ctx.residentRuntime.run({
      sessionId: ctx.sessionId,
      event: ctx.event,
      traceContext: ctx.traceContext,
      signal: (ctx.event.runtime as { signal?: AbortSignal } | undefined)?.signal,
    });
    const output = await dispatchWritebackCommit(ctx, residentResult.output);
    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);

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
    await createDurableWorkerRun(ctx, request);
    if (isBackgroundWorkerIngress(ctx)) {
      startBackgroundWorkerDispatch(ctx, request, target, start);
      const output = await dispatchWritebackCommit(
        ctx,
        JSON.stringify({
          accepted: true,
          status: "started",
          runId: request.runId,
          sessionId: ctx.sessionId,
        }),
      );
      SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
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
          const output = await dispatchWritebackCommit(
            ctx,
            coordinatorResult.output ?? coordinatorResult.error ?? "cancelled",
          );
          SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);
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
    const output = await dispatchWritebackCommit(ctx, coordinatorResult.output ?? "");
    SessionBridge.storeDirectResult(ctx.sessionId, output, ctx.event.agent.model);

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
