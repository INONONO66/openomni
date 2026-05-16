import type { Ingress, Tool } from "@openomni/protocol";
import { defineTool } from "../execution-runtime/tool/define";
import type { NativeTool } from "../execution-runtime/tool/types";
import {
  denyNonResidentCaller,
  requireAgentName,
  residentActor,
  toolResult,
  type WorkerAgentResolverInput,
} from "./worker-tool-common";

export interface ResidentWorkerToolsOptions {
  readonly ingest: (event: Ingress.InboundEvent) => Promise<Ingress.IngressResult>;
  readonly resolveWorkerAgent: (ctx: WorkerAgentResolverInput) => Ingress.AgentDef;
  readonly residentAgentNames: readonly string[];
  readonly surface: string;
}

type WorkerToolInput = {
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly callerAgentName?: string;
  readonly workspaceRoot?: string;
};

function guardWorkerCall(
  call: Tool.Call,
  input: WorkerToolInput,
  residentAgentNames: readonly string[],
): Tool.Result | undefined {
  return (
    denyNonResidentCaller(call, input, residentAgentNames) ??
    requireAgentName(call, input.agentName)
  );
}

function workerAgent(
  options: ResidentWorkerToolsOptions,
  input: WorkerToolInput,
): Ingress.AgentDef {
  return options.resolveWorkerAgent({
    agentName: input.agentName ?? "",
    workspaceRoot: input.workspaceRoot,
  });
}

function workerMeta(
  input: WorkerToolInput,
  residentAgentNames: readonly string[],
  target: Ingress.Target,
): Ingress.EventMetadata {
  return {
    actor: residentActor(input, residentAgentNames),
    target,
    agentName: input.agentName,
  };
}

function workerEvent(
  options: ResidentWorkerToolsOptions,
  input: WorkerToolInput & { readonly payload: string; readonly workerSessionId?: string },
  runtime: Ingress.ActivationMetadata,
  target: Ingress.Target,
): Ingress.InboundEvent {
  return {
    id: crypto.randomUUID(),
    surface: options.surface,
    workspace: input.workspaceRoot,
    mode: "direct",
    payload: input.payload,
    runtime,
    meta: workerMeta(input, options.residentAgentNames, target),
    agent: workerAgent(options, input),
  };
}

export function createResidentWorkerTools(options: ResidentWorkerToolsOptions): NativeTool[] {
  return [
    createSpawnWorkerTool(options),
    createSendWorkerMessageTool(options),
    createCancelWorkerTool(options),
    createResumeWorkerTool(options),
  ];
}

function createSpawnWorkerTool(options: ResidentWorkerToolsOptions): NativeTool {
  return defineTool<WorkerToolInput & { prompt: string }>({
    name: "spawn_worker",
    description: "Create a durable worker session and deliver an initial instruction.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Initial worker instruction" },
        sessionId: { type: "string" },
        agentName: { type: "string" },
        workspaceRoot: { type: "string" },
      },
      required: ["prompt", "agentName"],
    },
    source: "server",
    riskTier: 1,
    isReadOnly: false,
    isConcurrencySafe: true,
    implicitInputs: {
      sessionId: "sessionId",
      callerAgentName: "agentName",
      workspaceRoot: "workspaceRoot",
    },
    async execute(call) {
      const input = call.input;
      const denied = guardWorkerCall(call, input, options.residentAgentNames);
      if (denied) return denied;
      const ingressResult = await options.ingest(
        workerEvent(
          options,
          { ...input, payload: input.prompt },
          { durableSessionId: input.sessionId, lifecycle: "starting", background: true },
          { kind: "worker", parentSessionId: input.sessionId },
        ),
      );
      return toolResult(call, workerOutput(ingressResult));
    },
  });
}

function createSendWorkerMessageTool(options: ResidentWorkerToolsOptions): NativeTool {
  return defineTool<WorkerToolInput & { workerSessionId: string; message: string }>({
    name: "send_worker_message",
    description: "Send a message to an existing durable worker session.",
    inputSchema: {
      type: "object",
      properties: workerSessionInput({ message: { type: "string" } }),
      required: ["workerSessionId", "message", "agentName"],
    },
    source: "server",
    riskTier: 1,
    isReadOnly: false,
    isConcurrencySafe: true,
    implicitInputs: {
      sessionId: "sessionId",
      callerAgentName: "agentName",
      workspaceRoot: "workspaceRoot",
    },
    async execute(call) {
      const input = call.input;
      const denied = guardWorkerCall(call, input, options.residentAgentNames);
      if (denied) return denied;
      const ingressResult = await options.ingest(
        workerEvent(
          options,
          { ...input, payload: input.message },
          { durableSessionId: input.workerSessionId, lifecycle: "active", background: true },
          { kind: "worker", sessionId: input.workerSessionId },
        ),
      );
      return toolResult(call, workerOutput(ingressResult));
    },
  });
}

function createCancelWorkerTool(options: ResidentWorkerToolsOptions): NativeTool {
  return defineTool<WorkerToolInput & { workerSessionId: string; runId?: string; reason?: string }>(
    {
      name: "cancel_worker",
      description: "Request cancellation for an existing durable worker session.",
      inputSchema: {
        type: "object",
        properties: workerSessionInput({ runId: { type: "string" }, reason: { type: "string" } }),
        required: ["workerSessionId", "agentName"],
      },
      source: "server",
      riskTier: 1,
      isReadOnly: false,
      isConcurrencySafe: true,
      implicitInputs: {
        sessionId: "sessionId",
        callerAgentName: "agentName",
        workspaceRoot: "workspaceRoot",
      },
      async execute(call) {
        const input = call.input;
        const denied = guardWorkerCall(call, input, options.residentAgentNames);
        if (denied) return denied;
        const payload = input.reason
          ? `Cancel this worker run. Reason: ${input.reason}`
          : "Cancel this worker run and report the last safe state.";
        const ingressResult = await options.ingest(
          workerEvent(
            options,
            { ...input, payload },
            { durableSessionId: input.workerSessionId, runId: input.runId, lifecycle: "stopping" },
            { kind: "worker", sessionId: input.workerSessionId },
          ),
        );
        return toolResult(call, { status: "cancel-requested", ...workerOutput(ingressResult) });
      },
    },
  );
}

function createResumeWorkerTool(options: ResidentWorkerToolsOptions): NativeTool {
  return defineTool<WorkerToolInput & { workerSessionId: string; message?: string }>({
    name: "resume_worker",
    description: "Resume a durable worker session by sending an ingress message.",
    inputSchema: {
      type: "object",
      properties: workerSessionInput({ message: { type: "string" } }),
      required: ["workerSessionId", "agentName"],
    },
    source: "server",
    riskTier: 1,
    isReadOnly: false,
    isConcurrencySafe: true,
    implicitInputs: {
      sessionId: "sessionId",
      callerAgentName: "agentName",
      workspaceRoot: "workspaceRoot",
    },
    async execute(call) {
      const input = call.input;
      const denied = guardWorkerCall(call, input, options.residentAgentNames);
      if (denied) return denied;
      const ingressResult = await options.ingest(
        workerEvent(
          options,
          { ...input, payload: input.message ?? "Resume this worker session and report status." },
          { durableSessionId: input.workerSessionId, lifecycle: "hydrating", background: true },
          { kind: "worker", sessionId: input.workerSessionId },
        ),
      );
      return toolResult(call, workerOutput(ingressResult));
    },
  });
}

function workerSessionInput(extra: Record<string, { type: "string" }>): Record<string, unknown> {
  return {
    workerSessionId: { type: "string" },
    agentName: { type: "string" },
    sessionId: { type: "string" },
    workspaceRoot: { type: "string" },
    ...extra,
  };
}

function workerOutput(ingressResult: Ingress.IngressResult) {
  return {
    workerSessionId: ingressResult.sessionId,
    output: ingressResult.result.output,
    finishReason: ingressResult.result.finishReason,
  };
}
