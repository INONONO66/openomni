import { PolicyDecision, type Tool } from "@openomni/protocol";
import {
  EffectScopeRegistry,
  digestEffectValue,
  resolveToolEffect,
  type ResolvedToolEffectV1,
} from "../effect-scope.js";
import type { WorkspaceIdentity } from "../workspace-identity.js";
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
  publishToolCompleted,
  publishToolStarted,
  publishToolTimedOut,
} from "./executor-events.js";
import { hasUnknownSettlement } from "./executor-settlement.js";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";
import type {
  AcceptedToolEffectContext,
  NativeTool,
  ToolEffectIntentV1,
  ToolEffectSettlementStatus,
  ToolExecutionContext,
  ToolExecutorConfig,
} from "./types.js";

const acceptedEffectContexts = new WeakMap<
  object,
  { readonly operation: string; readonly workspaceId: string }
>();

/** Runtime check for the executor-minted, operation- and workspace-bound effect capability. */
export function hasAcceptedToolEffect(
  context: ToolExecutionContext | undefined,
  operation: string,
  workspace: WorkspaceIdentity,
): context is AcceptedToolEffectContext {
  const accepted = context === undefined ? undefined : acceptedEffectContexts.get(context);
  return accepted?.operation === operation && accepted.workspaceId === workspace.workspaceId;
}

export interface ToolExecutorContext {
  tools: NativeTool[];
  config?: ToolExecutorConfig;
}

function canonicalEffectValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEffectValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalEffectValue(nested)]),
    );
  }
  return value;
}

function exactEffectIdentity(args: {
  readonly call: Tool.Call;
  readonly input: Record<string, unknown>;
  readonly operation: string;
  readonly effect: ResolvedToolEffectV1;
  readonly config: ToolExecutorConfig;
}): { readonly effectId: string; readonly sourceRef: string } {
  const sourceRef = digestEffectValue(
    JSON.stringify({
      version: "tool-effect-source-v1",
      sessionId: args.config.runtime?.sessionId ?? null,
      runId: args.config.runtime?.runId ?? null,
      toolCallId: args.call.id,
      inputDigest: digestEffectValue(JSON.stringify(canonicalEffectValue(args.input))),
      operation: args.operation,
      operationVersion: args.effect.operationVersion,
      scope: args.effect.scope,
    }),
  );
  return { effectId: `tool-effect:${sourceRef}`, sourceRef };
}

function receiptDenial(status: string, reason?: string): Error {
  return new Error(`effect ledger denied: ${status}${reason ? ` (${reason})` : ""}`);
}

export function createToolExecutor(
  ctx: ToolExecutorContext,
): (call: Tool.Call, context?: ToolExecutionContext) => Promise<Tool.Result> {
  const dispatch = buildDispatchTable(ctx.tools);
  const config = ctx.config ?? {};
  const effects = config.effects;
  const scopeRegistry = new EffectScopeRegistry();
  const eventBase = () => createEventBase(config.runtime);

  return async (call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> => {
    const tool = dispatch.get(call.tool);
    if (!tool) return createErrorResult(call, `Unknown tool: ${call.tool}`);

    if (context?.signal?.aborted) return createErrorResult(call, "Tool execution aborted");

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
    let postToolOutput: string | undefined;
    let intent: ToolEffectIntentV1 | undefined;
    let intentAccepted = false;
    let settlementAttempted = false;
    let actStarted = false;
    const lockOwnerId = crypto.randomUUID();
    let executionContext: ToolExecutionContext | undefined;

    function evaluatePostToolOnce(): void {
      if (!policy || !shouldEvaluatePostTool) return;
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

    async function appendSettlement(status: ToolEffectSettlementStatus): Promise<void> {
      if (!intentAccepted || !intent || settlementAttempted) return;
      settlementAttempted = true;
      if (!effects) throw new Error("effect ledger is not provisioned");
      const receipt = await effects.appendSettlement({
        version: "tool-effect-settlement-v1",
        effectId: intent.effectId,
        sourceRef: intent.sourceRef,
        status,
      });
      if (receipt.version !== "tool-effect-append-receipt-v1" || receipt.status !== "accepted") {
        throw receiptDenial(receipt.status, receipt.reason);
      }
    }

    try {
      let readOnly = false;
      try {
        readOnly =
          typeof tool.isReadOnly === "function"
            ? tool.isReadOnly(dispatchedCall.input)
            : tool.isReadOnly;
      } catch {
        readOnly = false;
      }
      const resolvedEffect = readOnly
        ? null
        : resolveToolEffect(
            scopeRegistry,
            originalName,
            dispatchedCall.input,
            config.workspaceIdentity,
          );
      if (resolvedEffect && !effects) {
        throw new Error("effect ledger is not provisioned");
      }
      if (resolvedEffect) {
        const identity = exactEffectIdentity({
          call,
          input: dispatchedCall.input,
          operation: originalName,
          effect: resolvedEffect,
          config,
        });
        intent = Object.freeze({
          version: "tool-effect-intent-v1",
          ...identity,
          toolCallId: call.id,
          operation: originalName,
          operationVersion: resolvedEffect.operationVersion,
          scope: resolvedEffect.scope,
          execution: {
            sessionId: config.runtime?.sessionId ?? "",
            runId: config.runtime?.runId ?? "",
          },
        });
      }

      policy = await ToolRuntimePolicyMiddleware.evaluatePreTool({
        toolName: originalName,
        toolCallId: call.id,
        input: dispatchedCall.input,
        riskTier: tool.riskTier,
        ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
        timeoutConfig: config.timeoutMs,
        ...(resolvedEffect !== null && config.workspaceIdentity !== undefined
          ? { workspaceIdentity: config.workspaceIdentity }
          : {}),
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
        const reason = PolicyDecision.reason(policy.decision, "tool runtime policy aborted");
        publishActionBlocked({
          base: eventBase(),
          actionId,
          actor,
          resource: originalName,
          verdict: policy.decision.verdict,
          reason,
        });
        publishToolCompleted({
          base: eventBase(),
          actor,
          toolCallId: call.id,
          toolName: originalName,
          durationMs: 0,
          isError: true,
        });
        return createErrorResult(call, reason);
      }

      shouldEvaluatePostTool = true;
      if (intent) {
        if (!effects) throw new Error("effect ledger is not provisioned");
        const receipt = await effects.appendIntent(intent);
        if (receipt.version !== "tool-effect-append-receipt-v1" || receipt.status !== "accepted") {
          throw receiptDenial(receipt.status, receipt.reason);
        }
        intentAccepted = true;
      }

      const startTime = Date.now();
      if (linkedAbort.signal.aborted) throw createAbortError();
      publishToolStarted({
        base: eventBase(),
        actor,
        toolCallId: call.id,
        toolName: originalName,
      });

      executionContext = { ...context, signal: linkedAbort.signal };
      if (intentAccepted && intent) {
        acceptedEffectContexts.set(executionContext, {
          operation: intent.operation,
          workspaceId: intent.scope.workspace.workspaceId,
        });
      }
      actStarted = true;
      const toolExecution = tool.execute(dispatchedCall, executionContext);
      const result = await enforceTimeoutAndAbort(
        toolExecution,
        policy.handle.timeoutMs,
        context?.signal,
        (error) => abortController.abort(error),
      );
      const durationMs = Date.now() - startTime;
      postToolOutput = result.output;
      await appendSettlement(
        hasUnknownSettlement(result) ? "unknown" : result.isError === true ? "failed" : "confirmed",
      );
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
      let message = error instanceof Error ? error.message : String(error);
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

      if (intentAccepted && !settlementAttempted) {
        try {
          await appendSettlement(actStarted ? "unknown" : "failed");
        } catch (settlementError) {
          message =
            settlementError instanceof Error ? settlementError.message : String(settlementError);
          postToolOutput = message;
        }
      }
      evaluatePostToolOnce();

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
      return createErrorResult(call, message);
    } finally {
      if (executionContext) acceptedEffectContexts.delete(executionContext);
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
