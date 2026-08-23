import { ChatAgent, type ChatAgentConfig, type ChatAgentInput } from "@openomni/agent";
import { Session } from "@openomni/ledger";
import type { Gateway, Ingress, Message, Model } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

const RESIDENT_SYSTEM_PROMPT =
  "You are the Owner's Resident. Provide clear judgment and conversation only. You have no tools and cannot delegate or act in the world.";

interface ResidentOptions {
  readonly model: Model.Ref;
  readonly apiKey: string;
  readonly llm?: ChatAgentConfig["llm"];
}

function addTextPart(sessionId: string, messageId: string, text: string): void {
  Session.addPart(messageId, {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
  });
}

function history(sessionId: string): ChatAgentInput["messages"] {
  return Session.getMessages(sessionId).map((message) => ({
    role: message.role,
    content: Session.getParts(message.id)
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    time: message.time.created,
  }));
}

export function createResident(options: ResidentOptions) {
  const agent = ChatAgent.create({
    events: Bus,
    systemPrompt: RESIDENT_SYSTEM_PROMPT,
    tools: [],
    toolChoice: "none",
    model: options.model,
    auth: { type: "api", key: options.apiKey },
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  });

  return async function deliver(delivery: Gateway.Deliver): Promise<Ingress.IngressResult> {
    const sessionId = delivery.sessionId;
    if (sessionId === undefined) {
      throw new Error("Resident delivery requires a routed sessionId");
    }
    if (typeof delivery.event.payload !== "string") {
      throw new Error("Resident delivery payload must be text");
    }

    Session.materialize({
      id: sessionId,
      traceId: delivery.event.traceId,
      title: "Resident chat",
      model: { providerID: options.model.provider, modelID: options.model.id },
    });

    const userId = crypto.randomUUID();
    Session.addMessage(sessionId, {
      id: userId,
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      agent: "resident",
      model: { providerID: options.model.provider, modelID: options.model.id },
    });
    addTextPart(sessionId, userId, delivery.event.payload);

    const result = await agent.run({
      messages: history(sessionId),
      traceContext: {
        traceId: delivery.event.traceId,
        sessionId,
        runId: crypto.randomUUID(),
        agentName: "resident",
      },
    });

    const assistantId = crypto.randomUUID();
    Session.addMessage(sessionId, {
      id: assistantId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: userId,
      modelID: options.model.id,
      providerID: options.model.provider,
      agent: "resident",
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: {
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
        reasoning: result.usage.reasoningTokens ?? 0,
        cache: {
          read: result.usage.cacheReadTokens ?? 0,
          write: result.usage.cacheWriteTokens ?? 0,
        },
      },
      finish: result.finishReason,
    });
    addTextPart(sessionId, assistantId, result.text);

    return {
      mode: "direct",
      target: delivery.event.target ?? { kind: "resident" },
      sessionId,
      result: { output: result.text, finishReason: result.finishReason },
    };
  };
}
