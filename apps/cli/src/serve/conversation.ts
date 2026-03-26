import { Session } from "@openomni/session";
import { run, Provider } from "@openomni/llm";
import { Message, type Sink } from "@openomni/protocol";
import { SurfaceStore } from "./surface-store";
import type { Adapter } from "../adapter/types";

export interface ConversationConfig {
  model: Provider.Model;
  system?: string;
}

const LLM_TIMEOUT_MS = 120_000; // 2 minutes

// ---------------------------------------------------------------------------
// Message handler factory
// ---------------------------------------------------------------------------

/**
 * Create a message handler that routes inbound messages through the
 * conversation pipeline: session resolution -> LLM -> response.
 *
 * Each handler instance maintains its own per-surface serialization queue
 * to prevent history race conditions.
 */
export function createMessageHandler(config: ConversationConfig): Adapter.MessageHandler {
  const queues = new Map<string, Promise<unknown>>();

  return async (message) => {
    // TODO: respect Adapter.Config.deliveryPolicy - currently always delivers final response only
    const prev = queues.get(message.surfaceKey) ?? Promise.resolve();
    const current = prev.then(() => processMessage(message.surfaceKey, message.text, config));
    const tail = current.catch(() => {});
    queues.set(message.surfaceKey, tail);

    // Cleanup: remove queue entry when no more messages are pending
    tail.then(() => {
      if (queues.get(message.surfaceKey) === tail) queues.delete(message.surfaceKey);
    });

    const text = await current;
    return text ? { text } : null;
  };
}

// ---------------------------------------------------------------------------
// Message processing (runs inside per-surface queue)
// ---------------------------------------------------------------------------

function createUserMessage(
  sessionID: string,
  model: Provider.Model,
  text: string,
): Message.WithParts {
  const messageID = `msg-${crypto.randomUUID()}`;

  return {
    info: {
      id: messageID,
      sessionID,
      role: "user" as const,
      time: { created: Date.now() },
      agent: "serve",
      model: { providerID: model.providerID, modelID: model.id },
    },
    parts: [
      {
        id: `part-${crypto.randomUUID()}`,
        sessionID,
        messageID,
        type: "text" as const,
        text,
      },
    ],
  };
}

function loadHistory(sessionID: string): Message.WithParts[] {
  const messages = Session.getMessages(sessionID);
  return messages.map((info) => ({
    info,
    parts: Session.getParts(info.id),
  }));
}

async function processMessage(
  surfaceKey: string,
  text: string,
  config: ConversationConfig,
): Promise<string> {
  // 1. Resolve or create session
  let sessionId = SurfaceStore.lookup(surfaceKey);

  if (!sessionId) {
    const session = Session.create({
      title: surfaceKey,
      model: { providerID: config.model.providerID, modelID: config.model.id },
    });
    sessionId = session.id;
    SurfaceStore.register(surfaceKey, sessionId);
  }

  // 2. Create and persist user message
  const userMessage = createUserMessage(sessionId, config.model, text);
  Session.addMessage(sessionId, userMessage.info);
  for (const part of userMessage.parts) {
    Session.addPart(userMessage.info.id, part);
  }

  // 3. Load full conversation history
  const history = loadHistory(sessionId);

  // 4. Call LLM with timeout
  let assistantMessage: Message.WithParts | undefined;

  const sink: Sink = {
    onMessage(message) {
      assistantMessage = message;
    },
    onToolCall() {},
    onToolResult() {},
    onSnapshot() {},
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let outcome;
  try {
    outcome = await run(
      {
        messages: history,
        tools: [],
        model: config.model,
        system: config.system,
        signal: controller.signal,
      },
      sink,
    );
  } finally {
    clearTimeout(timeout);
  }

  // 5. Persist assistant response and extract text
  let responseText = "";

  if (assistantMessage) {
    Session.addMessage(sessionId, assistantMessage.info);
    for (const part of assistantMessage.parts) {
      Session.addPart(assistantMessage.info.id, part);
    }

    responseText = assistantMessage.parts
      .filter((p): p is Message.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("");
  }

  if (outcome.type === "error") {
    const msg = outcome.error?.message ?? "Unknown error";
    console.error(`[conversation] LLM error: ${msg}`);
    return `Error: ${msg}`;
  }

  if (outcome.type === "aborted") {
    console.error("[conversation] LLM call timed out");
    return "Sorry, the request timed out. Please try again.";
  }

  return responseText || "(no response)";
}
