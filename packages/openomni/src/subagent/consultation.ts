import { ChatAgent, type ChatAgentConfig } from "@openomni/agent";
import { type Message, Subagent } from "@openomni/protocol";
import { Bus, type BusEvent, Session, WorkerRun } from "@openomni/session";

type RuntimeModel = { provider: string; id: string };

type RuntimeMessage = { role: "user" | "assistant"; content: string };

type ConsultationConfig = {
  model: RuntimeModel;
  systemPrompt?: string;
  tools?: ChatAgentConfig["tools"];
  toolExecutor?: ChatAgentConfig["toolExecutor"];
  budget?: ChatAgentConfig["budget"];
};

function toSessionModel(model: RuntimeModel): { providerID: string; modelID: string } {
  return {
    providerID: model.provider,
    modelID: model.id,
  };
}

function createUserMessage(sessionId: string, model: RuntimeModel): Message.UserMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent: "subagent-consultation",
    model: toSessionModel(model),
  };
}

function createAssistantMessage(sessionId: string, model: RuntimeModel): Message.AssistantMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: model.id,
    providerID: model.provider,
    agent: "subagent-consultation",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function addTextPart(sessionId: string, messageId: string, text: string): void {
  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
  };
  Session.addPart(messageId, part);
}

function publishEvent<TPayload extends { sessionId?: string; runId?: string }>(
  event: BusEvent.Descriptor<{
    traceId: string;
    sessionId?: string;
    runId?: string;
    time: number;
    payload: TPayload;
  }>,
  payload: TPayload,
): void {
  Bus.publish(event, {
    traceId: crypto.randomUUID(),
    sessionId: payload.sessionId,
    runId: payload.runId,
    time: Date.now(),
    payload,
  });
}

function createRuntimeAgent(config: ConsultationConfig) {
  return ChatAgent.create({
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    budget: config.budget,
    toolExecutor: config.toolExecutor,
  });
}

function buildSessionContext(sessionId: string): RuntimeMessage[] {
  const messages = Session.getMessages(sessionId);
  const context: RuntimeMessage[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const content = Session.getParts(message.id)
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (!content) {
      continue;
    }

    context.push({ role: message.role, content });
  }

  return context;
}

export namespace SubagentConsultation {
  export async function consult(
    request: Subagent.ConsultationRequest,
    config: ConsultationConfig,
  ): Promise<Subagent.ConsultationResult> {
    if (request.mode === "active-session") {
      if (!request.targetSessionId) {
        throw new Error("targetSessionId is required for active-session mode");
      }

      publishEvent(Subagent.Events.WorkerConsultationRequested, {
        sessionId: request.sessionId,
        runId: request.runId,
        targetAgent: request.targetAgent,
        mode: "active-session",
      });

      const agent = createRuntimeAgent(config);
      const result = await agent.run({
        messages: [
          ...buildSessionContext(request.targetSessionId),
          { role: "user", content: request.question },
        ],
      });
      const consultationId = crypto.randomUUID();

      publishEvent(Subagent.Events.WorkerConsultationCompleted, {
        sessionId: request.sessionId,
        runId: request.runId,
        consultationId,
      });

      return {
        consultationId,
        guidance: result.text,
        source: request.targetAgent,
        mode: "active-session",
      };
    }

    const workerMeta = Subagent.ChildSessionMeta.parse({
      kind: "consultation",
      parentSessionId: request.sessionId,
      agentName: request.targetAgent,
      spawnDepth: 0,
      status: "idle",
    });

    const childSession = Session.createChild({
      parentSessionId: request.sessionId,
      title: "consultation",
      model: toSessionModel(config.model),
      workerMeta,
    });

    const userMessage = createUserMessage(childSession.id, config.model);
    Session.addMessage(childSession.id, userMessage);
    addTextPart(childSession.id, userMessage.id, request.question);

    const runId = crypto.randomUUID();
    await WorkerRun.create(childSession.id, {
      runId,
      title: "consultation",
      prompt: request.question,
    });
    await WorkerRun.updateStatus(childSession.id, runId, "starting");

    publishEvent(Subagent.Events.WorkerConsultationRequested, {
      sessionId: request.sessionId,
      runId: request.runId,
      targetAgent: request.targetAgent,
      mode: "fresh-session",
    });

    try {
      await WorkerRun.updateStatus(childSession.id, runId, "running");

      const agent = createRuntimeAgent(config);
      const result = await agent.run({
        messages: [{ role: "user", content: request.question }],
      });

      const assistantMessage = createAssistantMessage(childSession.id, config.model);
      Session.addMessage(childSession.id, assistantMessage);
      addTextPart(childSession.id, assistantMessage.id, result.text);

      await WorkerRun.updateStatus(childSession.id, runId, "succeeded", {
        endedAt: Date.now(),
        lastMessageId: assistantMessage.id,
      });

      const consultationId = crypto.randomUUID();

      publishEvent(Subagent.Events.WorkerConsultationCompleted, {
        sessionId: request.sessionId,
        runId: request.runId,
        consultationId,
      });

      return {
        consultationId,
        guidance: result.text,
        source: request.targetAgent,
        mode: "fresh-session",
      };
    } catch (error) {
      await WorkerRun.updateStatus(childSession.id, runId, "failed", {
        endedAt: Date.now(),
      });
      throw error;
    }
  }
}
