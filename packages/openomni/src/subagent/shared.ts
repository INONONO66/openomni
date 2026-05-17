import type { Message, Model } from "@openomni/protocol";
import { Subagent } from "@openomni/protocol";
import { Bus, type BusEvent, Session } from "@openomni/session";

export type RuntimeModel = Model.Ref;

export type RuntimeMessage = { role: "user" | "assistant"; content: string };

export function toSessionModel(model: RuntimeModel): { providerID: string; modelID: string } {
  return {
    providerID: model.provider,
    modelID: model.id,
  };
}

export function createUserMessage(
  sessionId: string,
  model: RuntimeModel,
  agent: string = "subagent-runtime",
): Message.UserMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent,
    model: toSessionModel(model),
  };
}

export function createAssistantMessage(
  sessionId: string,
  model: RuntimeModel,
  agent: string = "subagent-runtime",
): Message.AssistantMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: model.id,
    providerID: model.provider,
    agent,
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

export function addTextPart(sessionId: string, messageId: string, text: string): void {
  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
  };
  Session.addPart(messageId, part);
}

export function createSpawnSession(config: {
  parentSessionId?: string;
  agentName: string;
  title: string;
  model: RuntimeModel;
}): ReturnType<typeof Session.create> {
  const workerMeta = Subagent.ChildSessionMeta.parse({
    kind: "subagent",
    parentSessionId: config.parentSessionId,
    agentName: config.agentName,
    spawnDepth: config.parentSessionId ? undefined : 0,
    status: "idle",
  });

  const session = config.parentSessionId
    ? Session.createChild({
        parentSessionId: config.parentSessionId,
        title: config.title,
        model: toSessionModel(config.model),
        workerMeta,
      })
    : Session.create({
        title: config.title,
        model: toSessionModel(config.model),
      });

  if (!config.parentSessionId) {
    Session.updateWorkerMeta(session.id, workerMeta);
  }

  publishEvent(Subagent.Events.WorkerSessionSpawned, {
    sessionId: session.id,
    parentSessionId: config.parentSessionId,
    agentName: config.agentName,
    spawnDepth: session.spawnDepth,
    kind: "subagent",
  });

  return session;
}

export function publishEvent<TPayload extends { sessionId?: string; runId?: string }>(
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
