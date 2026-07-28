import { PolicyDecision, type Tool } from "@openomni/protocol";
import {
  createAbortError,
  enforceTimeoutAndAbort,
  isAbortError,
  linkAbortSignals,
} from "./executor-abort.js";
import {
  buildDispatchTable,
  injectImplicitInputs,
  resolveDispatchedCall,
} from "./executor-dispatch.js";
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
import {
  hasUnknownSettlement,
  markUnsafeWorkspaceForUnsettledTool,
  waitForToolSettlement,
} from "./executor-settlement.js";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";
import type { NativeTool, ToolExecutionContext, ToolExecutorConfig } from "./types.js";

const DEFAULT_POST_TIMEOUT_SETTLE_GRACE_MS = 5_000;

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
