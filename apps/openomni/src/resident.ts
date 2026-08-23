import { ChatAgent, type ChatAgentConfig, type ChatAgentInput } from "@openomni/agent";
import { Session } from "@openomni/ledger";
import type { Placement } from "@openomni/placement";
import type { Gateway, Ingress, Message, Model } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { DelegationOrigin } from "./delegation/admission";
import type { CatalogPorts } from "./tools/catalog";
import { catalogEntries, createDispatcher } from "./tools/catalog";

const RESIDENT_SYSTEM_PROMPT =
  "You are the Owner's Resident. You judge and decide; you do not execute. When work needs doing, hand it to a worker with the delegate tool and state plainly how it ended — a deadline passing means the outcome is unknown, not that the work failed.";

interface ResidentOptions {
  readonly model: Model.Ref;
  readonly apiKey: string;
  readonly llm?: ChatAgentConfig["llm"];
  /**
   * What this Resident can reach. An unwired port means the matching tool is
   * absent from the catalog entirely, rather than present and always refusing.
   */
  readonly tools: CatalogPorts;
  /**
   * The brain and whatever machines are attached, read at the start of each
   * turn. A function rather than a list because attachment is a fact about
   * the moment, not about composition: a machine that attaches between two
   * messages must be offerable on the second one.
   */
  readonly targets: () => readonly Placement.ToolTarget[];
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

const RESIDENT_ORIGIN: DelegationOrigin = { role: "resident", depth: 0 };

export function createResident(options: ResidentOptions) {
  const entries = catalogEntries(options.tools, RESIDENT_ORIGIN);

  return async function deliver(delivery: Gateway.Deliver): Promise<Ingress.IngressResult> {
    const targets = options.targets();
    const catalog = createDispatcher(entries);
    const agent = ChatAgent.create({
      events: Bus,
      systemPrompt: RESIDENT_SYSTEM_PROMPT,
      tools: catalog.specs,
      toolTargets: targets,
      toolChoice: catalog.specs.length === 0 ? "none" : "auto",
      toolExecutor: catalog.execute,
      model: options.model,
      auth: { type: "api", key: options.apiKey },
      ...(options.llm === undefined ? {} : { llm: options.llm }),
    });

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
