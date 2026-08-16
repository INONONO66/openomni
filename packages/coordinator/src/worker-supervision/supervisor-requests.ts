import { Ipc } from "@openomni/protocol";
import type {
  ActiveRequest,
  InboundWaitHandler,
  InboundWaitResult,
  ToolCallCancelParams,
  ToolCallHandler,
  ToolCallResult,
} from "./supervisor-types.js";

type RequestContext = {
  readonly authToken: string;
  readonly workerId: number;
  readonly activeToolCalls: Map<string, ActiveRequest>;
  readonly activeInboundWaitCalls: Map<string, ActiveRequest>;
  readonly toolCallHandler?: ToolCallHandler;
  readonly inboundWaitHandler?: InboundWaitHandler;
  readonly notifyToolCallSettled: (
    callId: string,
    workspaceRoot: string | undefined,
  ) => Promise<void>;
};

type Respond = (result: unknown) => void;

export function handleWorkerRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  switch (method) {
    case "worker.tool_call_cancel":
      handleToolCallCancel(params, respond, context);
      return;
    case "worker.tool_call":
      handleToolCall(params, respond, context);
      return;
    case "worker.inbound_wait_cancel":
      handleInboundWaitCancel(params, respond, context);
      return;
    case "worker.inbound_wait":
      handleInboundWait(params, respond, context);
      return;
    default:
      respond(null);
  }
}

function handleToolCallCancel(
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  const p = parseToolCallCancelParams(params);
  if (!p) {
    respond({ cancelled: false, error: "invalid worker.tool_call_cancel params" });
    return;
  }
  const active = context.activeToolCalls.get(p.callId);
  if (!active || active.runId !== p.runId || active.sessionId !== p.sessionId) {
    respond({ cancelled: false });
    return;
  }
  active.controller.abort();
  respondAndForget(context.activeToolCalls, p.callId, active, {
    id: p.callId,
    toolCallId: p.callId,
    output: "Tool call aborted",
    isError: true,
    settlement: "unknown",
  });
  respond({ cancelled: true, settlement: "unknown" });
}

function handleToolCall(
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  if (!context.toolCallHandler) {
    respond(null);
    return;
  }
  // Parse-don't-cast at the boundary (#QB1 BUG2): tool execution is the most
  // dangerous worker verb, so a malformed frame must never throw across the
  // handler (that TypeError crashed the coordinator). safeParse + a typed
  // error frame keep the handler total.
  const parsed = Ipc.Methods["worker.tool_call"].params.safeParse(params);
  if (!parsed.success) {
    respond(toolCallError(params, "invalid worker.tool_call params"));
    return;
  }
  const p = parsed.data;
  // The env-injected token proves the request came from the worker this
  // supervisor spawned. NOT every verb authenticates: the cancel verbs
  // (worker.tool_call_cancel, worker.inbound_wait_cancel) carry no token by
  // contract — their blast radius is bounded to aborting this worker's own
  // in-flight calls, and the 0700 per-pool socket dir is the transport gate.
  if (p.authToken !== context.authToken) {
    respond(toolCallError(p, "unauthorized worker request"));
    return;
  }
  const controller = new AbortController();
  const active: ActiveRequest = {
    runId: p.runId,
    sessionId: p.sessionId,
    ...(typeof p.workspaceRoot === "string" ? { workspaceRoot: p.workspaceRoot } : {}),
    controller,
    respond,
    completed: false,
  };
  context.activeToolCalls.set(p.callId, active);
  context
    .toolCallHandler(
      {
        runId: p.runId,
        sessionId: p.sessionId,
        callId: p.callId,
        tool: p.tool,
        input: p.input,
        ...(typeof p.workspaceRoot === "string" ? { workspaceRoot: p.workspaceRoot } : {}),
      },
      { signal: controller.signal },
    )
    .then((result) => respondAndForget(context.activeToolCalls, p.callId, active, result))
    .catch((err) =>
      respondAndForget(context.activeToolCalls, p.callId, active, {
        id: p.callId,
        toolCallId: p.callId,
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      }),
    )
    .finally(() => {
      context.activeToolCalls.delete(p.callId);
      void context.notifyToolCallSettled(p.callId, active.workspaceRoot);
    });
}

function handleInboundWaitCancel(
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  const p = parseInboundWaitCancelParams(params);
  if (!p) {
    respond({ cancelled: false, error: "invalid worker.inbound_wait_cancel params" });
    return;
  }
  const callId = p.callId;
  const active = context.activeInboundWaitCalls.get(callId);
  if (!active || active.sessionId !== p.sessionId || (active.runId ?? "") !== (p.runId ?? "")) {
    respond({ cancelled: false });
    return;
  }
  active.controller.abort();
  respondAndForget(context.activeInboundWaitCalls, callId, active, {
    requestId: callId,
    accepted: false,
    error: "worker.inbound_wait aborted",
  });
  respond({ cancelled: true, settlement: "unknown" });
}

function handleInboundWait(
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  const requestId = crypto.randomUUID();
  if (params?.authToken !== context.authToken) {
    respond({ requestId, accepted: false, error: "unauthorized worker request" });
    return;
  }
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
  const callId =
    typeof params?.callId === "string" && params.callId.length > 0 ? params.callId : requestId;
  const payload = typeof params?.payload === "string" ? params.payload : "";
  const workspaceRoot =
    typeof params?.workspaceRoot === "string" ? params.workspaceRoot : undefined;
  // The asking run carries its trace across the hop; the handler dispatches
  // under it rather than starting a second trace for the same conversation.
  const traceId = typeof params?.traceId === "string" ? params.traceId : "";
  if (!context.inboundWaitHandler || !sessionId || !payload || !traceId) {
    respond({
      requestId: callId,
      accepted: false,
      error: context.inboundWaitHandler
        ? "worker.inbound_wait requires traceId, sessionId and payload"
        : "worker.inbound_wait is not configured",
    });
    return;
  }

  const controller = new AbortController();
  const runId = typeof params?.runId === "string" ? params.runId : undefined;
  const active: ActiveRequest = {
    ...(runId !== undefined && { runId }),
    sessionId,
    ...(workspaceRoot !== undefined && { workspaceRoot }),
    controller,
    respond,
    completed: false,
  };
  context.activeInboundWaitCalls.set(callId, active);

  context
    .inboundWaitHandler({
      workerId: String(context.workerId),
      traceId,
      sessionId,
      callId,
      ...(runId !== undefined && { runId }),
      ...(workspaceRoot !== undefined && { workspaceRoot }),
      payload,
      signal: controller.signal,
    })
    .then((result: InboundWaitResult) =>
      respondAndForget(context.activeInboundWaitCalls, callId, active, result),
    )
    .catch((err: unknown) =>
      respondAndForget(context.activeInboundWaitCalls, callId, active, {
        requestId: callId,
        accepted: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    .finally(() => {
      context.activeInboundWaitCalls.delete(callId);
    });
}

/** Typed rejection frame for a tool call — a Tool.Result the sender can parse. */
function toolCallError(
  source: Record<string, unknown> | undefined,
  message: string,
): ToolCallResult {
  const callId = typeof source?.callId === "string" ? source.callId : "invalid";
  return { id: callId, toolCallId: callId, output: message, isError: true, settlement: "unknown" };
}

function respondAndForget(
  activeRequests: Map<string, ActiveRequest>,
  callId: string,
  active: ActiveRequest,
  result: unknown,
): void {
  if (active.completed) return;
  active.completed = true;
  active.respond(result);
  activeRequests.delete(callId);
}

function parseToolCallCancelParams(
  params: Record<string, unknown> | undefined,
): ToolCallCancelParams | undefined {
  if (!params) return undefined;
  const { runId, sessionId, callId } = params;
  if (typeof runId !== "string" || typeof sessionId !== "string" || typeof callId !== "string") {
    return undefined;
  }
  return { runId, sessionId, callId };
}

function parseInboundWaitCancelParams(
  params: Record<string, unknown> | undefined,
): { runId?: string; sessionId: string; callId: string } | undefined {
  if (!params) return undefined;
  const { runId, sessionId, callId } = params;
  if (typeof sessionId !== "string" || typeof callId !== "string") return undefined;
  return {
    ...(typeof runId === "string" ? { runId } : {}),
    sessionId,
    callId,
  };
}
