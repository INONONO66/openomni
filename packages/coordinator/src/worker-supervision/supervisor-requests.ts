import { Ipc } from "@openomni/protocol";
import type {
  CredentialProvisioningFrameV1,
  WorkerCredentialProvisioningPort,
  WorkerCredentialProvisioningSigner,
  WorkerKernelQueryPort,
  WorkerKernelTransitionPort,
  WorkerObservationPort,
} from "./supervisor.js";
import type {
  ActiveRequest,
  InboundWaitHandler,
  InboundWaitResult,
  ToolCallCancelParams,
  ToolCallHandler,
  ToolCallParams,
} from "./supervisor-types.js";

type PendingCredentialProvisioning = Readonly<{
  expected: Ipc.CredentialProvisioningAcknowledgementV1;
  acknowledge: Ipc.CredentialProvisioningPortResultV1["acknowledge"];
}>;

type RequestContext = {
  readonly authToken: string;
  readonly runtimeId?: string;
  readonly principalId?: string;
  readonly workerId: number;
  readonly generation: number;
  readonly processId: number;
  readonly isChannelAuthenticated: () => boolean;
  readonly activeToolCalls: Map<string, ActiveRequest>;
  readonly activeInboundWaitCalls: Map<string, ActiveRequest>;
  readonly toolCallHandler?: ToolCallHandler;
  readonly inboundWaitHandler?: InboundWaitHandler;
  readonly kernelTransition?: WorkerKernelTransitionPort;
  readonly kernelQuery?: WorkerKernelQueryPort;
  readonly observation?: WorkerObservationPort;
  readonly provisionCredentials?: WorkerCredentialProvisioningPort;
  readonly runtimeForRun: (
    runId: string,
    sessionId: string,
  ) => Ipc.WorkerRuntimeDefinitionV1 | undefined;
  readonly takeProvisioningSigner?: (
    attempt: CredentialProvisioningFrameV1["request"]["attempt"],
  ) => WorkerCredentialProvisioningSigner;
  readonly releaseProvisioningSigner?: (signer: WorkerCredentialProvisioningSigner) => void;
  readonly writePrivateFrame: (frame: Uint8Array) => void;
  credentialProvisioningState: "available" | "materializing" | "pending" | "terminal";
  pendingCredentialProvisioning: PendingCredentialProvisioning | undefined;
};

type Respond = (result: unknown) => void;

export function handleWorkerRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  if (method === "worker.credential_provision") {
    if (!authenticateWorkerChannel(params, context)) {
      respond({ ok: false, error: "unauthorized worker request" });
      return;
    }
    relayCredentialProvisioning(params, respond, context);
    return;
  }
  if (method === "worker.credential_provision_ack") {
    if (!context.isChannelAuthenticated()) {
      respond({ ok: false, error: "unauthorized worker request" });
      return;
    }
    relayCredentialProvisioningAcknowledgement(params, respond, context);
    return;
  }

  if (!authenticateWorkerRequest(params, context)) {
    respond({ ok: false, error: "unauthorized worker request" });
    return;
  }

  switch (method) {
    case "worker.kernel_transition":
      relayBoundKernelTransition(params, respond, context);
      return;
    case "worker.kernel_query":
      relayBoundKernelQuery(params, respond, context);
      return;
    case "worker.observation":
      relayObservation(params, respond, context);
      return;
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
      respond({ ok: false, error: `unsupported worker IPC method: ${method}` });
  }
}

function authenticateWorkerRequest(
  params: Record<string, unknown> | undefined,
  context: RequestContext,
): params is Record<string, unknown> {
  return params?.authToken === context.authToken && authenticateWorkerChannel(params, context);
}

function authenticateWorkerChannel(
  params: Record<string, unknown> | undefined,
  context: RequestContext,
): params is Record<string, unknown> {
  return (
    context.isChannelAuthenticated() &&
    params?.workerId === String(context.workerId) &&
    params.generation === context.generation
  );
}

function boundRuntime(runId: string, sessionId: string, context: RequestContext) {
  const runtime = context.runtimeForRun(runId, sessionId);
  if (
    runtime === undefined ||
    runtime.runtimeId !== context.runtimeId ||
    runtime.workerId !== String(context.workerId) ||
    runtime.generation !== context.generation ||
    runtime.principalId !== context.principalId
  ) {
    throw new Error("worker run is not bound to the authenticated channel");
  }
  return Object.freeze({
    identity: Object.freeze({
      runtimeId: runtime.runtimeId,
      workerId: runtime.workerId,
      generation: runtime.generation,
      principalId: runtime.principalId,
      processId: context.processId,
      attempt: runtime.attempt,
    }),
    runtime,
  });
}

function validateRunScope(
  params: Record<string, unknown>,
  context: RequestContext,
): Ipc.WorkerRuntimeDefinitionV1 {
  if (typeof params.runId !== "string" || typeof params.sessionId !== "string") {
    throw new Error("worker run scope is invalid");
  }
  return boundRuntime(params.runId, params.sessionId, context).runtime;
}

function validateWorkspace(params: { readonly workspaceRoot?: unknown }): void {
  if (params.workspaceRoot !== undefined) {
    throw new Error("worker workspace is server-bound");
  }
}
function relayBoundKernelTransition(
  params: Record<string, unknown>,
  respond: Respond,
  context: RequestContext,
): void {
  const port = context.kernelTransition;
  if (port === undefined) {
    respond({ ok: false, error: "worker.kernel_transition is not configured" });
    return;
  }
  try {
    const parsed = Ipc.Methods["worker.kernel_transition"].params.parse(params);
    const { authToken: _authToken, ...request } = parsed;
    const channelIdentity = boundRuntime(request.runId, request.sessionId, context).identity;
    port({ channelIdentity, request })
      .then(respond)
      .catch((error: unknown) => {
        respond({
          ok: false,
          error: error instanceof Error ? error.message : "kernel transition failed",
        });
      });
  } catch (error) {
    respond({
      ok: false,
      error: error instanceof Error ? error.message : "kernel transition denied",
    });
  }
}

function relayBoundKernelQuery(
  params: Record<string, unknown>,
  respond: Respond,
  context: RequestContext,
): void {
  const port = context.kernelQuery;
  if (port === undefined) {
    respond({ ok: false, error: "worker.kernel_query is not configured" });
    return;
  }
  try {
    const parsed = Ipc.Methods["worker.kernel_query"].params.parse(params);
    const { authToken: _authToken, ...request } = parsed;
    const channelIdentity = boundRuntime(request.runId, request.sessionId, context).identity;
    port({ channelIdentity, request })
      .then(respond)
      .catch((error: unknown) => {
        respond({
          ok: false,
          error: error instanceof Error ? error.message : "kernel query failed",
        });
      });
  } catch (error) {
    respond({ ok: false, error: error instanceof Error ? error.message : "kernel query denied" });
  }
}

function relayObservation(
  params: Record<string, unknown>,
  respond: Respond,
  context: RequestContext,
): void {
  const port = context.observation;
  try {
    const parsed = Ipc.Methods["worker.observation"].params.parse(params);
    const runtime = boundRuntime(parsed.runId, parsed.sessionId, context).runtime;
    if (!port) throw new Error("worker.observation is not configured");
    if (!isRecord(parsed.observation.data)) throw new Error("worker observation data is invalid");
    const data = parsed.observation.data;
    if (
      data.runId !== parsed.runId ||
      data.sessionId !== parsed.sessionId ||
      data.workerId !== runtime.workerId ||
      data.generation !== runtime.generation ||
      data.workItemId !== runtime.attempt.workItemId ||
      data.attemptId !== runtime.attempt.attemptId ||
      data.attemptSeq !== runtime.attempt.attemptSeq
    ) {
      throw new Error("worker observation identity mismatch");
    }
    port(parsed)
      .then(() => respond(null))
      .catch((error: unknown) => {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
  } catch (error) {
    respond({ ok: false, error: error instanceof Error ? error.message : "observation denied" });
  }
}

function relayCredentialProvisioning(
  params: Record<string, unknown>,
  respond: Respond,
  context: RequestContext,
): void {
  if (!context.provisionCredentials) {
    respond({ ok: false, error: "worker.credential_provision is not configured" });
    return;
  }
  const parsed = Ipc.Methods["worker.credential_provision"].params.safeParse(params);
  if (!parsed.success) {
    respond({ ok: false, error: "invalid worker.credential_provision params" });
    return;
  }
  const { request, runId, sessionId } = parsed.data;
  let binding: ReturnType<typeof boundRuntime>;
  try {
    binding = boundRuntime(runId, sessionId, context);
  } catch {
    respond({ ok: false, error: "credential provisioning identity mismatch" });
    return;
  }
  if (
    request.runtimeId !== binding.runtime.runtimeId ||
    request.workerId !== binding.runtime.workerId ||
    request.generation !== binding.runtime.generation ||
    request.principalId !== binding.runtime.principalId ||
    !sameAttempt(request.attempt, binding.runtime.attempt)
  ) {
    respond({ ok: false, error: "credential provisioning identity mismatch" });
    return;
  }
  if (context.credentialProvisioningState !== "available") {
    respond({ ok: false, error: "credentials already provisioned for this worker generation" });
    return;
  }
  context.credentialProvisioningState = "materializing";
  if (!context.takeProvisioningSigner) {
    context.credentialProvisioningState = "terminal";
    respond({ ok: false, error: "credential provisioning signer is not configured" });
    return;
  }
  const frame: CredentialProvisioningFrameV1 = {
    request,
    channelIdentity: { ...binding.identity, runId, sessionId },
  };
  let signer: WorkerCredentialProvisioningSigner;
  try {
    signer = context.takeProvisioningSigner(binding.runtime.attempt);
  } catch (error) {
    context.credentialProvisioningState = "terminal";
    respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  let provisioning: ReturnType<WorkerCredentialProvisioningPort>;
  try {
    provisioning = context.provisionCredentials(frame, signer);
  } catch (error) {
    context.credentialProvisioningState = "terminal";
    if (context.releaseProvisioningSigner) context.releaseProvisioningSigner(signer);
    else signer.dispose();
    respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  provisioning
    .then((result) => {
      const { privateFrame, receipt, acknowledge } = result;
      try {
        const validatedReceipt = Ipc.Methods["worker.credential_provision"].result.parse(receipt);
        if (
          validatedReceipt.runtimeId !== request.runtimeId ||
          validatedReceipt.workerId !== request.workerId ||
          validatedReceipt.generation !== request.generation ||
          validatedReceipt.principalId !== request.principalId ||
          !sameAttempt(validatedReceipt.attempt, request.attempt) ||
          validatedReceipt.nonceRef !== request.nonceRef ||
          context.credentialProvisioningState !== "materializing"
        ) {
          throw new Error("credential provisioning receipt mismatch");
        }
        const expected = Ipc.Methods["worker.credential_provision_ack"].params.parse({
          workerId: binding.runtime.workerId,
          generation: binding.runtime.generation,
          processId: context.processId,
          runId,
          sessionId,
          receipt: validatedReceipt,
        });
        context.writePrivateFrame(privateFrame);
        context.pendingCredentialProvisioning = { expected, acknowledge };
        context.credentialProvisioningState = "pending";
        respond(validatedReceipt);
      } finally {
        privateFrame.fill(0);
      }
    })
    .catch((error: unknown) => {
      context.pendingCredentialProvisioning = undefined;
      context.credentialProvisioningState = "terminal";
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      if (context.releaseProvisioningSigner) context.releaseProvisioningSigner(signer);
      else signer.dispose();
    });
}

function relayCredentialProvisioningAcknowledgement(
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  const pending = context.pendingCredentialProvisioning;
  context.pendingCredentialProvisioning = undefined;
  if (context.credentialProvisioningState !== "pending" || pending === undefined) {
    if (context.credentialProvisioningState !== "available") {
      context.credentialProvisioningState = "terminal";
    }
    respond({ ok: false, error: "credential provisioning acknowledgement denied" });
    return;
  }
  context.credentialProvisioningState = "terminal";
  const parsed = Ipc.Methods["worker.credential_provision_ack"].params.safeParse(params);
  if (!parsed.success || !sameAcknowledgement(parsed.data, pending.expected)) {
    respond({ ok: false, error: "credential provisioning acknowledgement denied" });
    return;
  }
  pending
    .acknowledge(parsed.data)
    .then(() => respond({ accepted: true }))
    .catch((error: unknown) => {
      respond({
        ok: false,
        error:
          error instanceof Error ? error.message : "credential provisioning acknowledgement denied",
      });
    });
}

function sameAcknowledgement(
  left: Ipc.CredentialProvisioningAcknowledgementV1,
  right: Ipc.CredentialProvisioningAcknowledgementV1,
): boolean {
  return (
    left.workerId === right.workerId &&
    left.generation === right.generation &&
    left.processId === right.processId &&
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    JSON.stringify(left.receipt) === JSON.stringify(right.receipt)
  );
}

function sameAttempt(
  left: CredentialProvisioningFrameV1["request"]["attempt"],
  right: CredentialProvisioningFrameV1["request"]["attempt"],
): boolean {
  return (
    left.version === right.version &&
    left.workItemId === right.workItemId &&
    left.attemptId === right.attemptId &&
    left.attemptSeq === right.attemptSeq
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function handleToolCallCancel(
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  try {
    validateRunScope(params ?? {}, context);
  } catch (error) {
    respond({ cancelled: false, error: error instanceof Error ? error.message : "cancel denied" });
    return;
  }
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
  let p: ToolCallParams;
  try {
    const parsed = Ipc.Methods["worker.tool_call"].params.parse(params);
    const runtime = boundRuntime(parsed.runId, parsed.sessionId, context).runtime;
    validateWorkspace(parsed);
    if (!runtime.config.toolCatalog.some((tool) => tool.name === parsed.tool)) {
      throw new Error("worker tool is not in the authenticated runtime catalog");
    }
    p = {
      runId: parsed.runId,
      sessionId: parsed.sessionId,
      callId: parsed.callId,
      tool: parsed.tool,
      input: parsed.input,
    };
  } catch (error) {
    respond({
      id: typeof params?.callId === "string" ? params.callId : "denied",
      toolCallId: typeof params?.callId === "string" ? params.callId : "denied",
      output: error instanceof Error ? error.message : "worker tool call denied",
      isError: true,
    });
    return;
  }
  if (!context.toolCallHandler) {
    respond(null);
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
    .toolCallHandler(p, { signal: controller.signal })
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
    });
}

function handleInboundWaitCancel(
  params: Record<string, unknown> | undefined,
  respond: Respond,
  context: RequestContext,
): void {
  try {
    validateRunScope(params ?? {}, context);
  } catch (error) {
    respond({ cancelled: false, error: error instanceof Error ? error.message : "cancel denied" });
    return;
  }
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
  let parsed: ReturnType<(typeof Ipc.Methods)["worker.inbound_wait"]["params"]["parse"]>;
  try {
    parsed = Ipc.Methods["worker.inbound_wait"].params.parse(params);
    boundRuntime(parsed.runId, parsed.sessionId, context);
    validateWorkspace(parsed);
  } catch (error) {
    respond({
      requestId,
      accepted: false,
      error: error instanceof Error ? error.message : "worker.inbound_wait denied",
    });
    return;
  }
  const { sessionId, runId, payload } = parsed;
  const callId = parsed.callId ?? requestId;
  if (!context.inboundWaitHandler) {
    respond({ requestId: callId, accepted: false, error: "worker.inbound_wait is not configured" });
    return;
  }
  const controller = new AbortController();
  const active: ActiveRequest = {
    runId,
    sessionId,
    controller,
    respond,
    completed: false,
  };
  context.activeInboundWaitCalls.set(callId, active);

  context
    .inboundWaitHandler({
      workerId: String(context.workerId),
      sessionId,
      callId,
      runId,
      payload,
      signal: controller.signal,
    })
    .then((result: InboundWaitResult) =>
      respondInboundWaitAndForget(context.activeInboundWaitCalls, callId, active, result),
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

async function respondInboundWaitAndForget(
  activeRequests: Map<string, ActiveRequest>,
  callId: string,
  active: ActiveRequest,
  result: InboundWaitResult,
): Promise<void> {
  if (active.completed) return;
  active.completed = true;
  const { deliverySettlement, ...wireResult } = result;
  try {
    active.respond(wireResult);
  } catch (error) {
    await deliverySettlement?.failed();
    activeRequests.delete(callId);
    throw error;
  }
  await deliverySettlement?.confirmed();
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
