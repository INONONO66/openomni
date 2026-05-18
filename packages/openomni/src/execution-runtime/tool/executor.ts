import {
  Operational,
  PolicyDecision,
  PolicyEvent,
  ToolExecution,
  type Policy,
  type Tool,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";
import type {
  ImplicitInputSource,
  NativeTool,
  ToolExecutionContext,
  ToolExecutorConfig,
  ToolRuntimeContext,
} from "./types.js";
import { WorkspaceLock } from "../workspace-lock.js";

const TOOL_CALL_ACTION = "tool.call";
const DEFAULT_POST_TIMEOUT_SETTLE_GRACE_MS = 5_000;

export interface ToolExecutorContext {
  tools: NativeTool[];
  config?: ToolExecutorConfig;
}

function buildDispatchTable(tools: NativeTool[]): Map<string, NativeTool> {
  const dispatch = new Map<string, NativeTool>();
  for (const tool of tools) {
    dispatch.set(tool.spec.name, tool);
    const sanitized = tool.spec.name.replace(/\./g, "_");
    if (sanitized !== tool.spec.name) dispatch.set(sanitized, tool);
  }
  return dispatch;
}

function createErrorResult(call: Tool.Call, message: string): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: message,
    isError: true,
  };
}

function createAbortError(): Error {
  const error = new Error("Tool execution aborted");
  error.name = "AbortError";
  return error;
}

function hasUnknownSettlement(result: Tool.Result): boolean {
  return result.settlement === "unknown";
}

function buildActor(runtime: ToolRuntimeContext | undefined): Record<string, unknown> {
  return {
    kind: "agent",
    ...(runtime?.agentName !== undefined && { agentName: runtime.agentName }),
    ...(runtime?.sessionId !== undefined && { sessionId: runtime.sessionId }),
    ...(runtime?.runId !== undefined && { runId: runtime.runId }),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason;
}

function linkAbortSignals(
  localSignal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  if (!parentSignal) return { signal: localSignal, cleanup: () => undefined };

  const linked = new AbortController();
  const forwardLocalAbort = () => {
    if (!linked.signal.aborted) linked.abort(abortReason(localSignal));
  };
  const forwardParentAbort = () => {
    if (!linked.signal.aborted) linked.abort(abortReason(parentSignal));
  };

  if (localSignal.aborted) forwardLocalAbort();
  if (parentSignal.aborted) forwardParentAbort();

  localSignal.addEventListener("abort", forwardLocalAbort, { once: true });
  parentSignal.addEventListener("abort", forwardParentAbort, { once: true });

  return {
    signal: linked.signal,
    cleanup: () => {
      localSignal.removeEventListener("abort", forwardLocalAbort);
      parentSignal.removeEventListener("abort", forwardParentAbort);
    },
  };
}

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return typeof input;
  }
  const keys = Object.keys(input).sort();
  return keys.length === 0 ? "empty" : keys.join(",");
}

function resolveImplicitValue(
  source: ImplicitInputSource,
  runtime: ToolRuntimeContext,
): string | undefined {
  switch (source) {
    case "sessionId":
      return runtime.sessionId;
    case "runId":
      return runtime.runId;
    case "agentName":
      return runtime.agentName;
    case "workspaceRoot":
      return runtime.workspaceRoot;
  }
}

function injectImplicitInputs(
  call: Tool.Call,
  tool: NativeTool,
  runtime: ToolRuntimeContext | undefined,
): Tool.Call {
  if (!tool.implicitInputs || !runtime) return call;

  const injected: Record<string, unknown> = { ...(call.input as Record<string, unknown>) };
  for (const [param, source] of Object.entries(tool.implicitInputs)) {
    const value = resolveImplicitValue(source, runtime);
    if (value !== undefined) injected[param] = value;
  }
  return { ...call, input: injected };
}

function publishPolicyEvaluated(
  base: { traceId: string; sessionId: string; runId?: string; time: number },
  actor: Record<string, unknown>,
  resource: string,
  decision: Policy.PolicyDecision,
): void {
  Bus.publish(PolicyEvent.Evaluated, {
    ...base,
    policyId: decision.policyId,
    actor,
    action: TOOL_CALL_ACTION,
    resource,
    verdict: decision.verdict,
    reason: PolicyDecision.reason(decision, "runtime policy evaluated"),
  });
}

type ToolSettlementOutcome =
  | { readonly settled: true; readonly output: string }
  | {
      readonly settled: false;
      readonly clearWhenToolSettles: boolean;
      readonly unsafeToken?: string;
    };

function waitForToolSettlement(
  promise: Promise<Tool.Result>,
  graceMs: number,
): Promise<ToolSettlementOutcome> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = globalThis.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({ settled: false, clearWhenToolSettles: true });
    }, graceMs);
    const finish = (outcome: ToolSettlementOutcome) => {
      if (resolved) return;
      resolved = true;
      globalThis.clearTimeout(timer);
      resolve(outcome);
    };

    promise.then(
      (result) => {
        if (hasUnknownSettlement(result)) {
          finish({
            settled: false,
            clearWhenToolSettles: false,
            unsafeToken: result.toolCallId || result.id,
          });
          return;
        }
        finish({ settled: true, output: result.output });
      },
      (error: unknown) =>
        finish({
          settled: true,
          output: error instanceof Error ? error.message : String(error),
        }),
    );
  });
}

async function enforceTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: (error: ToolRuntimePolicyMiddleware.TimeoutError) => void,
): Promise<T> {
  if (signal?.aborted) throw createAbortError();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutFired = false;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => finish(() => reject(createAbortError()));
    const timer = globalThis.setTimeout(() => {
      timeoutFired = true;
      const error = new ToolRuntimePolicyMiddleware.TimeoutError(timeoutMs);
      finish(() => reject(error));
      try {
        onTimeout(error);
      } catch {
        // Timeout rejection is authoritative; cleanup callbacks must not
        // escape the timer turn as uncaught exceptions.
      }
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => {
        if (timeoutFired) return;
        finish(() => reject(error));
      },
    );
  });
}

export function createToolExecutor(
  ctx: ToolExecutorContext,
): (call: Tool.Call, context?: ToolExecutionContext) => Promise<Tool.Result> {
  const dispatch = buildDispatchTable(ctx.tools);
  const config = ctx.config ?? {};
  const postTimeoutSettleGraceMs =
    config.postTimeoutSettleGraceMs ?? DEFAULT_POST_TIMEOUT_SETTLE_GRACE_MS;
  const { workspaceRoot } = config;
  const runtime = config.runtime;

  function eventBase() {
    return {
      traceId: crypto.randomUUID(),
      sessionId: runtime?.sessionId ?? "",
      ...(runtime?.runId !== undefined && { runId: runtime.runId }),
      time: Date.now(),
    };
  }

  return async (call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> => {
    const tool = dispatch.get(call.tool);
    if (!tool) {
      return createErrorResult(call, `Unknown tool: ${call.tool}`);
    }

    if (context?.signal?.aborted) {
      return createErrorResult(call, "Tool execution aborted");
    }

    const originalName = tool.spec.name;
    const actionId = crypto.randomUUID();
    const actor = buildActor(runtime);
    let cleanupAbortSignal: (() => void) | undefined;
    const abortController = new AbortController();
    const linkedAbort = linkAbortSignals(abortController.signal, context?.signal);
    cleanupAbortSignal = linkedAbort.cleanup;
    if (linkedAbort.signal.aborted) throw createAbortError();

    Bus.publish(PolicyEvent.ActionRequested, {
      ...eventBase(),
      actionId,
      actor,
      action: TOOL_CALL_ACTION,
      resource: originalName,
      context: { inputSummary: summarizeInput(call.input) },
    });

    const enrichedCall = injectImplicitInputs(call, tool, runtime);
    const dispatchedCall =
      originalName === enrichedCall.tool ? enrichedCall : { ...enrichedCall, tool: originalName };
    let policy: ToolRuntimePolicyMiddleware.PreToolResult | undefined;
    let shouldEvaluatePostTool = false;
    let postToolDeferred = false;
    let postToolOutput: string | undefined;
    let toolExecution: Promise<Tool.Result> | undefined;
    const lockOwnerId = crypto.randomUUID();

    function evaluatePostToolOnce(): void {
      if (!policy || !shouldEvaluatePostTool || postToolDeferred) return;

      shouldEvaluatePostTool = false;
      const postDecision = ToolRuntimePolicyMiddleware.evaluatePostTool({
        toolName: originalName,
        toolCallId: call.id,
        input: dispatchedCall.input,
        output: postToolOutput,
        handle: policy.handle,
      });
      publishPolicyEvaluated(eventBase(), actor, originalName, postDecision);
    }

    function deferPostToolUntilExecutionSettles(fallbackOutput: string): void {
      if (!toolExecution || !policy || !shouldEvaluatePostTool || postToolDeferred) return;

      postToolDeferred = true;
      void waitForToolSettlement(toolExecution, postTimeoutSettleGraceMs).then((outcome) => {
        if (outcome.settled) {
          postToolOutput = outcome.output;
        } else {
          postToolOutput = fallbackOutput;
          if (policy?.handle.workspaceRoot && policy.handle.lockAcquired) {
            WorkspaceLock.markUnsafe(
              policy.handle.workspaceRoot,
              `tool "${originalName}" did not settle after timeout/abort grace`,
              outcome.unsafeToken ?? call.id,
            );
            const unsafeWorkspace = policy.handle.workspaceRoot;
            const unsafeToken = outcome.unsafeToken ?? call.id;
            if (outcome.clearWhenToolSettles) {
              void toolExecution
                ?.finally(() => WorkspaceLock.clearUnsafe(unsafeWorkspace, unsafeToken))
                .catch(() => undefined);
            }
          }
          Bus.publish(Operational.Warn, {
            ...eventBase(),
            component: "executor",
            msg: "timed-out tool did not settle before post-timeout grace elapsed",
            context: {
              toolName: originalName,
              toolCallId: call.id,
              graceMs: postTimeoutSettleGraceMs,
            },
          });
        }
        postToolDeferred = false;
        evaluatePostToolOnce();
      });
    }

    try {
      policy = await ToolRuntimePolicyMiddleware.evaluatePreTool({
        toolName: originalName,
        toolCallId: call.id,
        input: dispatchedCall.input,
        riskTier: tool.riskTier,
        ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
        timeoutConfig: config.timeoutMs,
        workspaceRoot,
        lockOwnerId,
        signal: linkedAbort.signal,
      });

      publishPolicyEvaluated(eventBase(), actor, originalName, policy.decision);

      if (PolicyDecision.isBlocking(policy.decision)) {
        const result = createErrorResult(
          call,
          PolicyDecision.reason(policy.decision, "tool runtime policy aborted"),
        );
        Bus.publish(PolicyEvent.ActionBlocked, {
          ...eventBase(),
          actionId,
          actor,
          action: TOOL_CALL_ACTION,
          resource: originalName,
          verdict: policy.decision.verdict,
          reason: PolicyDecision.reason(policy.decision, "tool runtime policy aborted"),
        });
        Bus.publish(ToolExecution.Completed, {
          ...eventBase(),
          actor,
          toolCallId: call.id,
          toolName: originalName,
          durationMs: 0,
          isError: true,
        });
        return result;
      }

      shouldEvaluatePostTool = true;
      const startTime = Date.now();
      if (linkedAbort.signal.aborted) throw createAbortError();

      Bus.publish(ToolExecution.Started, {
        ...eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
      });

      toolExecution = tool.execute(dispatchedCall, { signal: linkedAbort.signal });
      const result = await enforceTimeoutAndAbort(
        toolExecution,
        policy.handle.timeoutMs,
        context?.signal,
        (error) => abortController.abort(error),
      );
      const durationMs = Date.now() - startTime;
      postToolOutput = result.output;

      if (hasUnknownSettlement(result)) {
        deferPostToolUntilExecutionSettles(result.output);
        Bus.publish(ToolExecution.Completed, {
          ...eventBase(),
          actor,
          toolCallId: call.id,
          toolName: originalName,
          durationMs,
          isError: result.isError ?? false,
        });
        return result;
      }

      evaluatePostToolOnce();

      Bus.publish(ToolExecution.Completed, {
        ...eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
        durationMs,
        isError: result.isError ?? false,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof ToolRuntimePolicyMiddleware.TimeoutError;
      const isAbort = isAbortError(error);
      postToolOutput = message;

      if (isTimeout && policy) {
        const timeoutMs = (error as ToolRuntimePolicyMiddleware.TimeoutError).timeoutMs;
        Bus.publish(ToolExecution.TimedOut, {
          ...eventBase(),
          toolCallId: call.id,
          toolName: originalName,
          timeoutMs,
        });
      }

      if (isTimeout || isAbort) {
        deferPostToolUntilExecutionSettles(message);
      } else {
        evaluatePostToolOnce();
      }

      const result = createErrorResult(call, message);
      if (isTimeout || isAbort) {
        Bus.publish(PolicyEvent.ActionBlocked, {
          ...eventBase(),
          actionId,
          actor,
          action: TOOL_CALL_ACTION,
          resource: originalName,
          verdict: "deny" as const,
          reason: message,
        });
      }
      Bus.publish(ToolExecution.Completed, {
        ...eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
        durationMs: 0,
        isError: true,
      });
      return result;
    } finally {
      cleanupAbortSignal?.();
      evaluatePostToolOnce();
    }
  };
}
