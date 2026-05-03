import {
  Guardrail,
  ToolExecution,
  type ExecutionEvent,
  type Hook,
  type Tool,
} from "@openomni/protocol";
import { Bus, EventLog, Log, Storage } from "@openomni/session";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";
import type {
  ImplicitInputSource,
  NativeTool,
  ToolExecutorConfig,
  ToolRuntimeContext,
} from "./types.js";

const TOOL_CALL_ACTION = "tool.call";
const TOOL_LEDGER_VISIBILITY = "internal";

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

function normalizePermission(
  permission: Guardrail.Permission | undefined,
): Guardrail.Permission | undefined {
  if (!permission) return undefined;
  if (permission.action) return permission;
  return { ...permission, action: TOOL_CALL_ACTION };
}

function evaluatePermission(
  toolName: string,
  input: Record<string, unknown>,
  permission: Guardrail.Permission | undefined,
): Guardrail.EvaluationResult {
  return Guardrail.evaluate(normalizePermission(permission), {
    action: TOOL_CALL_ACTION,
    resource: toolName,
    input,
  });
}

function permissionErrorMessage(toolName: string, result: Guardrail.EvaluationResult): string {
  if (result.reason === "require_approval" || result.reason === "input_rule_require_approval") {
    return `[Blocked] Tool "${toolName}" requires approval: ${result.reason}`;
  }

  if (result.reason === "denylist" || result.reason === "input_rule_deny") {
    return `[Blocked] Tool "${toolName}" denied by policy: ${result.reason}`;
  }

  return `[Blocked] Tool "${toolName}" blocked by policy: ${result.reason}`;
}

function createErrorResult(call: Tool.Call, message: string): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: message,
    isError: true,
  };
}

function buildActor(runtime: ToolRuntimeContext | undefined): Record<string, unknown> {
  return {
    kind: "agent",
    ...(runtime?.agentName !== undefined && { agentName: runtime.agentName }),
    ...(runtime?.sessionId !== undefined && { sessionId: runtime.sessionId }),
    ...(runtime?.runId !== undefined && { runId: runtime.runId }),
  };
}

function ledgerUnavailableReason(sessionId: string): string | undefined {
  const adapter = Storage.get();
  if (adapter.eventLog === undefined)
    return "EventLog adapter unavailable for mandatory tool audit";
  if (adapter.session.get(sessionId) === undefined) {
    return "Session unavailable for mandatory tool audit";
  }
  return undefined;
}

function shouldBlockOnPreAppend(
  riskTier: NativeTool["riskTier"],
  options: { beforeSideEffect: boolean },
): boolean {
  return options.beforeSideEffect && riskTier >= 1;
}

async function readNextSequence(sessionId: string): Promise<number> {
  let maxSequence = 0;
  for await (const event of EventLog.replay(sessionId)) {
    maxSequence = Math.max(maxSequence, event.sequence);
  }
  return maxSequence + 1;
}

function ledgerActionId(
  sessionId: string,
  toolCallId: string,
  eventType: ExecutionEvent["type"],
  sequence: number,
): string {
  return `${sessionId}:tool.${eventType}:${toolCallId}:${sequence}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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

export function createToolExecutor(
  ctx: ToolExecutorContext,
): (call: Tool.Call) => Promise<Tool.Result> {
  const dispatch = buildDispatchTable(ctx.tools);
  const config = ctx.config ?? {};
  const { workspaceRoot } = config;
  const lockOwnerId = crypto.randomUUID();

  const runtime = config.runtime;
  const sequenceReservations = new Map<string, Promise<number>>();

  function reserveSequence(sessionId: string): Promise<number> {
    const current = sequenceReservations.get(sessionId) ?? readNextSequence(sessionId);
    sequenceReservations.set(
      sessionId,
      current.then(
        (sequence) => sequence + 1,
        () => 1,
      ),
    );
    return current;
  }

  async function appendLedgerEvent(
    tool: NativeTool,
    call: Tool.Call,
    eventType: ExecutionEvent["type"],
    event: (base: {
      readonly actionId: string;
      readonly parentActionId?: string;
      readonly visibility: typeof TOOL_LEDGER_VISIBILITY;
      readonly timestamp: string;
      readonly sequence: number;
    }) => ExecutionEvent,
    options: { beforeSideEffect: boolean; parentActionId?: string | undefined },
  ): Promise<ExecutionEvent | undefined> {
    const sessionId = runtime?.sessionId;
    if (!sessionId) return undefined;

    const shouldBlock = shouldBlockOnPreAppend(tool.riskTier, options);
    const unavailableReason = ledgerUnavailableReason(sessionId);
    if (unavailableReason !== undefined) {
      const error = new Error(unavailableReason);
      if (shouldBlock) throw error;
      return undefined;
    }

    try {
      const sequence = await reserveSequence(sessionId);
      const row = event({
        actionId: ledgerActionId(sessionId, call.id, eventType, sequence),
        ...(options.parentActionId !== undefined && { parentActionId: options.parentActionId }),
        visibility: TOOL_LEDGER_VISIBILITY,
        timestamp: new Date().toISOString(),
        sequence,
      });
      await EventLog.append(sessionId, row);
      return row;
    } catch (error) {
      if (shouldBlock) throw error;
      Log.warn("executor: EventLog append failed", {
        toolName: tool.spec.name,
        toolCallId: call.id,
        sessionId,
        error: String(error),
      });
      return undefined;
    }
  }

  async function appendPolicyPostVerdict(
    tool: NativeTool,
    call: Tool.Call,
    toolName: string,
    verdict: Hook.Verdict,
    parentActionId: string | undefined,
  ): Promise<void> {
    await appendLedgerEvent(
      tool,
      call,
      "policy_evaluated",
      (base): ExecutionEvent.PolicyEvaluated => ({
        type: "policy_evaluated",
        policyId: verdict.policyId ?? "tool.runtime-policy",
        actor: buildActor(runtime),
        action: TOOL_CALL_ACTION,
        resource: toolName,
        verdict: verdict.action,
        reason: verdict.reason ?? "runtime policy post-tool evaluated",
        ...base,
      }),
      { beforeSideEffect: false, parentActionId },
    );
  }

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const tool = dispatch.get(call.tool);
    if (!tool) {
      return createErrorResult(call, `Unknown tool: ${call.tool}`);
    }

    const originalName = tool.spec.name;
    let parentActionId: string | undefined;
    try {
      const requested = await appendLedgerEvent(
        tool,
        call,
        "action_requested",
        (base): ExecutionEvent.ActionRequested => ({
          type: "action_requested",
          actor: buildActor(runtime),
          action: TOOL_CALL_ACTION,
          resource: originalName,
          input: call.input,
          ...base,
        }),
        { beforeSideEffect: true },
      );
      parentActionId = requested?.actionId;
    } catch (error) {
      return createErrorResult(call, error instanceof Error ? error.message : String(error));
    }

    const permissionResult = evaluatePermission(originalName, call.input, config.permissions);
    if (config.permissions) {
      try {
        await appendLedgerEvent(
          tool,
          call,
          "policy_evaluated",
          (base): ExecutionEvent.PolicyEvaluated => ({
            type: "policy_evaluated",
            policyId: permissionResult.policyId,
            actor: buildActor(runtime),
            action: TOOL_CALL_ACTION,
            resource: originalName,
            verdict: permissionResult.action,
            reason: permissionResult.reason,
            ...base,
          }),
          { beforeSideEffect: permissionResult.action === "continue", parentActionId },
        );
      } catch (error) {
        return createErrorResult(call, error instanceof Error ? error.message : String(error));
      }
    }

    if (permissionResult.action === "abort") {
      Log.warn("executor: permission blocked", {
        toolName: originalName,
        reason: permissionResult.reason,
        matchedPattern: permissionResult.matchedPattern,
      });
      const result = createErrorResult(
        call,
        permissionErrorMessage(originalName, permissionResult),
      );
      await appendLedgerEvent(
        tool,
        call,
        "action_blocked",
        (base): ExecutionEvent.ActionBlocked => ({
          type: "action_blocked",
          policyId: permissionResult.policyId,
          actor: buildActor(runtime),
          action: TOOL_CALL_ACTION,
          resource: originalName,
          verdict: permissionResult.action,
          reason: permissionResult.reason,
          ...base,
        }),
        { beforeSideEffect: false, parentActionId },
      );
      await appendLedgerEvent(
        tool,
        call,
        "tool_completed",
        (base): ExecutionEvent.ToolCompleted => ({
          type: "tool_completed",
          toolCallId: call.id,
          result,
          ...base,
        }),
        { beforeSideEffect: false, parentActionId },
      );
      return result;
    }

    const enrichedCall = injectImplicitInputs(call, tool, runtime);
    const dispatchedCall =
      originalName === enrichedCall.tool ? enrichedCall : { ...enrichedCall, tool: originalName };
    let policy: ToolRuntimePolicyMiddleware.PreToolResult | undefined;

    try {
      policy = await ToolRuntimePolicyMiddleware.evaluatePreTool({
        toolName: originalName,
        toolCallId: call.id,
        input: dispatchedCall.input,
        riskTier: tool.riskTier,
        timeoutConfig: config.timeoutMs,
        workspaceRoot,
        lockOwnerId,
      });
      const prePolicy = policy;
      await appendLedgerEvent(
        tool,
        call,
        "policy_evaluated",
        (base): ExecutionEvent.PolicyEvaluated => ({
          type: "policy_evaluated",
          policyId: prePolicy.verdict.policyId ?? "tool.runtime-policy",
          actor: buildActor(runtime),
          action: TOOL_CALL_ACTION,
          resource: originalName,
          verdict: prePolicy.verdict.action,
          reason: prePolicy.verdict.reason ?? "runtime policy evaluated",
          ...base,
        }),
        { beforeSideEffect: prePolicy.verdict.action === "continue", parentActionId },
      );

      if (prePolicy.verdict.action !== "continue") {
        const result = createErrorResult(
          call,
          prePolicy.verdict.reason ?? "tool runtime policy aborted",
        );
        await appendLedgerEvent(
          tool,
          call,
          "action_blocked",
          (base): ExecutionEvent.ActionBlocked => ({
            type: "action_blocked",
            policyId: prePolicy.verdict.policyId ?? "tool.runtime-policy",
            actor: buildActor(runtime),
            action: TOOL_CALL_ACTION,
            resource: originalName,
            verdict: prePolicy.verdict.action,
            reason: prePolicy.verdict.reason ?? "tool runtime policy aborted",
            ...base,
          }),
          { beforeSideEffect: false, parentActionId },
        );
        await appendLedgerEvent(
          tool,
          call,
          "tool_completed",
          (base): ExecutionEvent.ToolCompleted => ({
            type: "tool_completed",
            toolCallId: call.id,
            result,
            ...base,
          }),
          { beforeSideEffect: false, parentActionId },
        );
        return result;
      }

      await appendLedgerEvent(
        tool,
        call,
        "tool_started",
        (base): ExecutionEvent.ToolStarted => ({
          type: "tool_started",
          toolCallId: call.id,
          toolName: originalName,
          args: dispatchedCall.input,
          ...base,
        }),
        { beforeSideEffect: true, parentActionId },
      );

      const result = await ToolRuntimePolicyMiddleware.enforceTimeout(
        tool.execute(dispatchedCall),
        policy.handle.timeoutMs,
      );
      const postVerdict = await ToolRuntimePolicyMiddleware.evaluatePostTool({
        toolName: originalName,
        toolCallId: call.id,
        input: dispatchedCall.input,
        output: result.output,
        handle: policy.handle,
      });
      await appendPolicyPostVerdict(tool, call, originalName, postVerdict, parentActionId);
      await appendLedgerEvent(
        tool,
        call,
        "tool_completed",
        (base): ExecutionEvent.ToolCompleted => ({
          type: "tool_completed",
          toolCallId: call.id,
          result,
          ...base,
        }),
        { beforeSideEffect: false, parentActionId },
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof ToolRuntimePolicyMiddleware.TimeoutError;
      const isAbort = isAbortError(error);

      if (isTimeout && policy) {
        const timeoutMs = (error as ToolRuntimePolicyMiddleware.TimeoutError).timeoutMs;
        const sessionId = runtime?.sessionId ?? "";
        Bus.publish(ToolExecution.TimedOut, {
          traceId: crypto.randomUUID(),
          sessionId,
          ...(runtime?.runId !== undefined && { runId: runtime.runId }),
          toolCallId: call.id,
          toolName: originalName,
          timeoutMs,
          time: Date.now(),
        });
      }

      if (policy?.verdict.action === "continue") {
        const postVerdict = await ToolRuntimePolicyMiddleware.evaluatePostTool({
          toolName: originalName,
          toolCallId: call.id,
          input: dispatchedCall.input,
          output: message,
          handle: policy.handle,
        });
        await appendPolicyPostVerdict(tool, call, originalName, postVerdict, parentActionId);
      }
      const result = createErrorResult(call, message);
      if (isTimeout || isAbort) {
        await appendLedgerEvent(
          tool,
          call,
          "action_blocked",
          (base): ExecutionEvent.ActionBlocked => ({
            type: "action_blocked",
            policyId: isTimeout ? "tool.runtime-policy.timeout" : "tool.runtime-policy.abort",
            actor: buildActor(runtime),
            action: TOOL_CALL_ACTION,
            resource: originalName,
            verdict: "abort",
            reason: message,
            ...base,
          }),
          { beforeSideEffect: false, parentActionId },
        );
      }
      await appendLedgerEvent(
        tool,
        call,
        "tool_completed",
        (base): ExecutionEvent.ToolCompleted => ({
          type: "tool_completed",
          toolCallId: call.id,
          result,
          ...base,
        }),
        { beforeSideEffect: false, parentActionId },
      );
      return result;
    }
  };
}
