import { Plan, type Message } from "@openomni/protocol";
import { Session } from "@openomni/session";

const PLAN_PREFIX = "__OPENOMNI_PLAN__";

function createAssistantMessage(
  sessionId: string,
  model: { provider: string; id: string },
): Message.AssistantMessage {
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
  export function buildPlanGoal(sessionId: string): string {
    const messages = Session.getMessages(sessionId);

    // Scan for the last plan in session
    let lastPlanJson: string | undefined;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const parts = Session.getParts(message.id);
      for (const part of parts) {
        if (part.type === "text" && part.text.startsWith(PLAN_PREFIX)) {
          lastPlanJson = part.text.slice(PLAN_PREFIX.length);
        }
      }
    }

    // Get the latest user message text
    let latestUserText = "";
    for (const message of messages) {
      if (message.role === "user") {
        const parts = Session.getParts(message.id);
        for (const part of parts) {
          if (part.type === "text") {
            latestUserText = part.text;
          }
        }
      }
    }

    if (!lastPlanJson) {
      return latestUserText;
    }

    return `Previous plan:\n${lastPlanJson}\n\nUser feedback:\n${latestUserText}`;
  }

  export function extractPlan(sessionId: string): Plan {
    const messages = Session.getMessages(sessionId);

    let lastPlanText: string | undefined;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const parts = Session.getParts(message.id);
      for (const part of parts) {
        if (part.type === "text" && part.text.startsWith(PLAN_PREFIX)) {
          lastPlanText = part.text.slice(PLAN_PREFIX.length);
        }
      }
    }

    if (!lastPlanText) {
      throw new Error("No plan found in session");
    }

    const parsed = JSON.parse(lastPlanText);
    return Plan.Schema.parse(parsed);
  }

  export function buildDirectMessages(
    sessionId: string,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const messages = Session.getMessages(sessionId);
    const result: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const message of messages) {
      const parts = Session.getParts(message.id);
      for (const part of parts) {
        if (part.type === "text" && !part.text.startsWith(PLAN_PREFIX)) {
          result.push({ role: message.role, content: part.text });
        }
      }
    }

    return result;
  }

  export function storePlanResult(
    sessionId: string,
    result: Plan.Result,
    model: { provider: string; id: string },
  ): void {
    const message = createAssistantMessage(sessionId, model);
    Session.addMessage(sessionId, message);

    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: PLAN_PREFIX + JSON.stringify(result.plan),
    };
    Session.addPart(message.id, part);
  }

  export function storeDirectResult(
    sessionId: string,
    output: string,
    model: { provider: string; id: string },
  ): void {
    const message = createAssistantMessage(sessionId, model);
    Session.addMessage(sessionId, message);

    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: output,
    };
    Session.addPart(message.id, part);
  }
}
