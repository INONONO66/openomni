import type { Message, Model } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { createIngressAudit, summarizeText } from "./audit-envelope";

// legacy marker from removed plan mode; filter from history to avoid leaking into model input
const LEGACY_PLAN_MARKER = "__OPENOMNI_PLANID__";

function createAssistantMessage(sessionId: string, model: Model.Ref): Message.AssistantMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: model.id,
    providerID: model.provider,
    agent: "session-bridge",
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

export namespace SessionBridge {
  export function buildDirectMessages(
    sessionId: string,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const messages = Session.getMessages(sessionId);
    const result: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const message of messages) {
      const parts = Session.getParts(message.id);
      for (const part of parts) {
        if (part.type === "text" && !part.text.startsWith(LEGACY_PLAN_MARKER)) {
          result.push({ role: message.role, content: part.text });
        }
      }
    }

    return result;
  }

  export function storeDirectResult(sessionId: string, output: string, model: Model.Ref): void {
    const message = createAssistantMessage(sessionId, model);
    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: output,
    };

    const audit = createIngressAudit(sessionId, "session_bridge");
    const writebackEvent = audit.append("ingress.writeback.direct_result", {
      sessionId,
      mode: "direct",
      source: "session-bridge",
      messageId: message.id,
      partId: part.id,
      role: message.role,
      text: summarizeText(output),
    });
    const messageEvent = audit.append(
      "ingress.writeback.message.write",
      {
        sessionId,
        mode: "direct",
        source: "session-bridge",
        messageId: message.id,
        role: message.role,
      },
      writebackEvent?.actionId,
    );
    Session.addMessage(sessionId, message);

    audit.append(
      "ingress.writeback.part.write",
      {
        sessionId,
        mode: "direct",
        source: "session-bridge",
        messageId: message.id,
        partId: part.id,
        role: message.role,
        partType: part.type,
        text: summarizeText(output),
      },
      messageEvent?.actionId,
    );
    Session.addPart(message.id, part);
  }
}
