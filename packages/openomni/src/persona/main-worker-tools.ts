import type { Ingress, Tool } from "@openomni/protocol";
import { defineTool } from "../execution-runtime/tool/define";
import type { NativeTool } from "../execution-runtime/tool/types";

export interface MainWorkerToolsOptions {
  readonly ingest: (event: Ingress.InboundEvent) => Promise<Ingress.IngressResult>;
  readonly defaultModel: { provider: string; id: string };
  readonly createWorkerAgent?: (ctx: {
    agentName: string;
    model: { provider: string; id: string };
    workspaceRoot?: string;
  }) => Ingress.AgentDef;
  readonly defaultWorkerAgentName?: string;
  readonly mainAgentNames?: readonly string[];
  readonly surface?: string;
}

function result(call: Tool.Call, output: unknown, isError = false): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: typeof output === "string" ? output : JSON.stringify(output),
    ...(isError ? { isError: true } : {}),
  };
}

function fallbackWorkerAgent(model: { provider: string; id: string }): Ingress.AgentDef {
  return {
    model,
    systemPrompt:
      "You are an OpenOmni worker. Complete the delegated task and report concise results.",
    budget: { maxTurns: 12 },
    tools: [],
  };
}

function isMainCaller(agentName: string | undefined, mainAgentNames: readonly string[]): boolean {
  if (!agentName) return false;
  return mainAgentNames.includes(agentName);
}

function mainActor(
  input: { sessionId?: string; callerAgentName?: string },
  mainAgentNames: readonly string[],
) {
  const main = isMainCaller(input.callerAgentName, mainAgentNames);
  return {
    role: main ? "main" : "agent",
    sessionId: input.sessionId,
    agentName: input.callerAgentName,
    isMain: main,
  };
}

function ensureMainCaller(
  call: Tool.Call,
  input: { callerAgentName?: string },
  mainAgentNames: readonly string[],
): Tool.Result | undefined {
  if (isMainCaller(input.callerAgentName, mainAgentNames)) return undefined;
  return result(
    call,
    `worker control tools require an explicit Main Persona caller (${mainAgentNames.join(", ")})`,
    true,
  );
}

export function createMainWorkerTools(options: MainWorkerToolsOptions): NativeTool[] {
  const surface = options.surface ?? "main-worker-tool";
  const defaultWorkerAgentName = options.defaultWorkerAgentName ?? "dev";
  const mainAgentNames = options.mainAgentNames ?? ["main", "main_persona"];
  const workerAgent = (input: { agentName?: string; workspaceRoot?: string }) => {
    const agentName = input.agentName ?? defaultWorkerAgentName;
    return options.createWorkerAgent
      ? options.createWorkerAgent({
          agentName,
          model: options.defaultModel,
          workspaceRoot: input.workspaceRoot,
        })
      : fallbackWorkerAgent(options.defaultModel);
  };
  const spawnWorker = defineTool<{
    prompt: string;
    sessionId?: string;
    agentName?: string;
    callerAgentName?: string;
    workspaceRoot?: string;
  }>({
    name: "spawn_worker",
    description:
      "Create a durable worker session and deliver an initial instruction through ingress.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Initial worker instruction" },
        sessionId: { type: "string" },
        agentName: { type: "string" },
        workspaceRoot: { type: "string" },
      },
      required: ["prompt"],
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
      const denied = ensureMainCaller(call, input, mainAgentNames);
      if (denied) return denied;
      const ingressResult = await options.ingest({
        id: crypto.randomUUID(),
        surface,
        workspace: input.workspaceRoot,
        mode: "direct",
        payload: input.prompt,
        runtime: {
          durableSessionId: input.sessionId,
          lifecycle: "starting",
          background: true,
        },
        meta: {
          actor: mainActor(input, mainAgentNames),
          target: { kind: "new-worker", parentSessionId: input.sessionId },
          agentName: input.agentName ?? defaultWorkerAgentName,
        },
        agent: workerAgent({ agentName: input.agentName, workspaceRoot: input.workspaceRoot }),
      });
      return result(call, {
        workerSessionId: ingressResult.sessionId,
        output: ingressResult.result.output,
        finishReason: ingressResult.result.finishReason,
      });
    },
  });

  const sendWorkerMessage = defineTool<{
    workerSessionId: string;
    message: string;
    sessionId?: string;
    agentName?: string;
    callerAgentName?: string;
    workspaceRoot?: string;
  }>({
    name: "send_worker_message",
    description: "Send a message to an existing durable worker session through ingress.",
    inputSchema: {
      type: "object",
      properties: {
        workerSessionId: { type: "string" },
        message: { type: "string" },
        sessionId: { type: "string" },
        agentName: { type: "string" },
        workspaceRoot: { type: "string" },
      },
      required: ["workerSessionId", "message"],
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
      const denied = ensureMainCaller(call, input, mainAgentNames);
      if (denied) return denied;
      const ingressResult = await options.ingest({
        id: crypto.randomUUID(),
        surface,
        workspace: input.workspaceRoot,
        mode: "direct",
        payload: input.message,
        runtime: {
          durableSessionId: input.workerSessionId,
          lifecycle: "active",
          background: true,
        },
        meta: {
          actor: mainActor(input, mainAgentNames),
          target: { kind: "worker", sessionId: input.workerSessionId },
          agentName: input.agentName ?? defaultWorkerAgentName,
        },
        agent: workerAgent({ agentName: input.agentName, workspaceRoot: input.workspaceRoot }),
      });
      return result(call, {
        workerSessionId: ingressResult.sessionId,
        output: ingressResult.result.output,
        finishReason: ingressResult.result.finishReason,
      });
    },
  });

  const cancelWorker = defineTool<{
    workerSessionId: string;
    runId?: string;
    reason?: string;
    sessionId?: string;
    agentName?: string;
    callerAgentName?: string;
    workspaceRoot?: string;
  }>({
    name: "cancel_worker",
    description:
      "Send a cancellation request to an existing durable worker session through ingress.",
    inputSchema: {
      type: "object",
      properties: {
        workerSessionId: { type: "string" },
        runId: { type: "string" },
        reason: { type: "string" },
        sessionId: { type: "string" },
        agentName: { type: "string" },
        workspaceRoot: { type: "string" },
      },
      required: ["workerSessionId"],
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
      const denied = ensureMainCaller(call, input, mainAgentNames);
      if (denied) return denied;
      const ingressResult = await options.ingest({
        id: crypto.randomUUID(),
        surface,
        workspace: input.workspaceRoot,
        mode: "direct",
        payload: input.reason
          ? `Cancel this worker run. Reason: ${input.reason}`
          : "Cancel this worker run and report the last safe state.",
        runtime: {
          durableSessionId: input.workerSessionId,
          runId: input.runId,
          lifecycle: "stopping",
        },
        meta: {
          actor: mainActor(input, mainAgentNames),
          target: { kind: "worker", sessionId: input.workerSessionId },
          agentName: input.agentName ?? defaultWorkerAgentName,
        },
        agent: workerAgent({ agentName: input.agentName, workspaceRoot: input.workspaceRoot }),
      });
      return result(call, {
        workerSessionId: ingressResult.sessionId,
        status: "cancel-requested",
        output: ingressResult.result.output,
        finishReason: ingressResult.result.finishReason,
      });
    },
  });

  const resumeWorker = defineTool<{
    workerSessionId: string;
    message?: string;
    sessionId?: string;
    agentName?: string;
    callerAgentName?: string;
    workspaceRoot?: string;
  }>({
    name: "resume_worker",
    description: "Recreate/resume a durable worker session by sending an ingress message.",
    inputSchema: {
      type: "object",
      properties: {
        workerSessionId: { type: "string" },
        message: { type: "string" },
        sessionId: { type: "string" },
        agentName: { type: "string" },
        workspaceRoot: { type: "string" },
      },
      required: ["workerSessionId"],
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
      const denied = ensureMainCaller(call, input, mainAgentNames);
      if (denied) return denied;
      const ingressResult = await options.ingest({
        id: crypto.randomUUID(),
        surface,
        workspace: input.workspaceRoot,
        mode: "direct",
        payload: input.message ?? "Resume this worker session and report status.",
        runtime: {
          durableSessionId: input.workerSessionId,
          lifecycle: "hydrating",
          background: true,
        },
        meta: {
          actor: mainActor(input, mainAgentNames),
          target: { kind: "worker", sessionId: input.workerSessionId },
          agentName: input.agentName ?? defaultWorkerAgentName,
        },
        agent: workerAgent({ agentName: input.agentName, workspaceRoot: input.workspaceRoot }),
      });
      return result(call, {
        workerSessionId: ingressResult.sessionId,
        output: ingressResult.result.output,
        finishReason: ingressResult.result.finishReason,
      });
    },
  });

  return [spawnWorker, sendWorkerMessage, cancelWorker, resumeWorker];
}
