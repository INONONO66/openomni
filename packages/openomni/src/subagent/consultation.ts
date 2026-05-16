import { ChatAgent, type ChatAgentConfig } from "@openomni/agent";
import { type Message, Subagent } from "@openomni/protocol";
import { Session, WorkerRun } from "@openomni/session";
import {
  type RuntimeModel,
  type RuntimeMessage,
  toSessionModel,
  createUserMessage,
  createAssistantMessage,
  addTextPart,
  publishEvent,
} from "./shared";

type ConsultationConfig = {
  model: RuntimeModel;
  auth?: ChatAgentConfig["auth"];
  allowAuthFallback?: ChatAgentConfig["allowAuthFallback"];
  systemPrompt?: string;
  tools?: ChatAgentConfig["tools"];
  toolExecutor?: ChatAgentConfig["toolExecutor"];
  budget?: ChatAgentConfig["budget"];
};

function createRuntimeAgent(config: ConsultationConfig) {
  return ChatAgent.create({
    model: config.model,
    auth: config.auth,
    allowAuthFallback: config.allowAuthFallback,
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

    const userMessage = createUserMessage(childSession.id, config.model, "subagent-consultation");
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

      const assistantMessage = createAssistantMessage(
        childSession.id,
        config.model,
        "subagent-consultation",
      );
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
