import { PolicyDecision, type Tool } from "@openomni/protocol";
import { WorkspaceLock } from "../workspace-lock.js";
import {
  buildActor,
  createEventBase,
  publishActionBlocked,
  publishActionRequested,
  publishPolicyEvaluated,
  publishTimeoutSettlementWarning,
  publishToolCompleted,
  publishToolStarted,
  publishToolTimedOut,
} from "./executor-events.js";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";
import type {
  ImplicitInputSource,
  NativeTool,
  ToolExecutionContext,
  ToolExecutorConfig,
  ToolRuntimeContext,
} from "./types.js";

const DEFAULT_POST_TIMEOUT_SETTLE_GRACE_MS = 5_000;

function createAbortError(): Error {
  const error = new Error("Tool execution aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason;
}

function linkAbortSignals(
  localSignal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
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

export async function enforceTimeoutAndAbort<T>(
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
        return;
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

function buildDispatchTable(tools: readonly NativeTool[]): Map<string, NativeTool> {
  const dispatch = new Map<string, NativeTool>();
  for (const tool of tools) {
    dispatch.set(tool.spec.name, tool);
    const sanitized = tool.spec.name.replace(/\./g, "_");
    if (sanitized !== tool.spec.name) dispatch.set(sanitized, tool);
  }
  return dispatch;
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

  const injected: Record<string, unknown> = { ...call.input };
  for (const [param, source] of Object.entries(tool.implicitInputs)) {
    const value = resolveImplicitValue(source, runtime);
    if (value !== undefined) injected[param] = value;
  }
  return { ...call, input: injected };
}

function resolveDispatchedCall(call: Tool.Call, tool: NativeTool): Tool.Call {
  const originalName = tool.spec.name;
  return originalName === call.tool ? call : { ...call, tool: originalName };
}

type ToolSettlementOutcome =
  | { readonly settled: true; readonly output: string }
  | {
      readonly settled: false;
      readonly clearWhenToolSettles: boolean;
      readonly unsafeToken?: string;
    };

function hasUnknownSettlement(result: Tool.Result): boolean {
  return result.settlement === "unknown";
}

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

function markUnsafeWorkspaceForUnsettledTool(args: {
  readonly workspaceRoot: string | undefined;
  readonly lockAcquired: boolean;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly outcome: Extract<ToolSettlementOutcome, { readonly settled: false }>;
  readonly toolExecution: Promise<Tool.Result>;
}): void {
  if (!args.workspaceRoot || !args.lockAcquired) return;

  const workspaceRoot = args.workspaceRoot;
  const unsafeToken = args.outcome.unsafeToken ?? args.toolCallId;
  WorkspaceLock.markUnsafe(
    workspaceRoot,
    `tool "${args.toolName}" did not settle after timeout/abort grace`,
    unsafeToken,
  );
  if (args.outcome.clearWhenToolSettles) {
    void args.toolExecution
      .finally(() => WorkspaceLock.clearUnsafe(workspaceRoot, unsafeToken))
      .catch(() => undefined);
  }
}

export interface ToolExecutorContext {
  tools: NativeTool[];
  config?: ToolExecutorConfig;
}

export function createToolExecutor(
  ctx: ToolExecutorContext,
): (call: Tool.Call, context?: ToolExecutionContext) => Promise<Tool.Result> {
  const dispatch = buildDispatchTable(ctx.tools);
  const config = ctx.config ?? {};
  const postTimeoutSettleGraceMs =
    config.postTimeoutSettleGraceMs ?? DEFAULT_POST_TIMEOUT_SETTLE_GRACE_MS;
  const eventBase = () => createEventBase(config.runtime);

  return async (call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> => {
    const tool = dispatch.get(call.tool);
    if (!tool) return createErrorResult(call, `Unknown tool: ${call.tool}`);

    if (context?.signal?.aborted) {
      return createErrorResult(call, "Tool execution aborted");
    }

    const originalName = tool.spec.name;
    const actionId = crypto.randomUUID();
    const actor = buildActor(config.runtime);
    const abortController = new AbortController();
    const linkedAbort = linkAbortSignals(abortController.signal, context?.signal);
    if (linkedAbort.signal.aborted) throw createAbortError();

    publishActionRequested({
      base: eventBase(),
      actionId,
      actor,
      resource: originalName,
      input: call.input,
    });

    const enrichedCall = injectImplicitInputs(call, tool, config.runtime);
    const dispatchedCall = resolveDispatchedCall(enrichedCall, tool);
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
      publishPolicyEvaluated({
        base: eventBase(),
        actor,
        resource: originalName,
        decision: postDecision,
      });
    }

    function deferPostToolUntilExecutionSettles(fallbackOutput: string): void {
      if (!toolExecution || !policy || !shouldEvaluatePostTool || postToolDeferred) return;

      const currentPolicy = policy;
      const currentToolExecution = toolExecution;
      postToolDeferred = true;
      void waitForToolSettlement(currentToolExecution, postTimeoutSettleGraceMs).then((outcome) => {
        if (outcome.settled) {
          postToolOutput = outcome.output;
        } else {
          postToolOutput = fallbackOutput;
          markUnsafeWorkspaceForUnsettledTool({
            workspaceRoot: currentPolicy.handle.workspaceRoot,
            lockAcquired: currentPolicy.handle.lockAcquired,
            toolName: originalName,
            toolCallId: call.id,
            outcome,
            toolExecution: currentToolExecution,
          });
          publishTimeoutSettlementWarning({
            base: eventBase(),
            toolName: originalName,
            toolCallId: call.id,
            graceMs: postTimeoutSettleGraceMs,
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
        workspaceRoot: config.workspaceRoot,
        lockOwnerId,
        signal: linkedAbort.signal,
      });

      publishPolicyEvaluated({
        base: eventBase(),
        actor,
        resource: originalName,
        decision: policy.decision,
      });

      if (PolicyDecision.isBlocking(policy.decision)) {
        const result = createErrorResult(
          call,
          PolicyDecision.reason(policy.decision, "tool runtime policy aborted"),
        );
        publishActionBlocked({
          base: eventBase(),
          actionId,
          actor,
          resource: originalName,
          verdict: policy.decision.verdict,
          reason: PolicyDecision.reason(policy.decision, "tool runtime policy aborted"),
        });
        publishToolCompleted({
          base: eventBase(),
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

      publishToolStarted({
        base: eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
      });

      const executionContext = { ...context, signal: linkedAbort.signal };
      toolExecution = tool.execute(dispatchedCall, executionContext);
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
        publishToolCompleted({
          base: eventBase(),
          actor,
          toolCallId: call.id,
          toolName: originalName,
          durationMs,
          isError: result.isError ?? false,
        });
        return result;
      }

      evaluatePostToolOnce();

      publishToolCompleted({
        base: eventBase(),
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
        publishToolTimedOut({
          base: eventBase(),
          toolCallId: call.id,
          toolName: originalName,
          timeoutMs: error.timeoutMs,
        });
      }

      if (isTimeout || isAbort) {
        deferPostToolUntilExecutionSettles(message);
      } else {
        evaluatePostToolOnce();
      }

      const result = createErrorResult(call, message);
      if (isTimeout || isAbort) {
        publishActionBlocked({
          base: eventBase(),
          actionId,
          actor,
          resource: originalName,
          verdict: "deny" as const,
          reason: message,
        });
      }
      publishToolCompleted({
        base: eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
        durationMs: 0,
        isError: true,
      });
      return result;
    } finally {
      linkedAbort.cleanup();
      evaluatePostToolOnce();
    }
  };
}

export function createErrorResult(call: Tool.Call, message: string): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: message,
    isError: true,
  };
}
