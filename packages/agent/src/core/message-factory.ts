import type { Message } from "@openomni/protocol";

export function createUserMessage(
  content: string,
  sessionID: string,
  partMetadata?: Message.TextPart["metadata"],
  // Hydrated messages retain their recorded creation time.
  timeCreated?: number,
): Message.WithParts {
  const id = crypto.randomUUID();
  const now = timeCreated ?? Date.now();
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: now },
    agent: sessionID,
    model: { providerID: "", modelID: "" },
  };

  return withTextPart(info, content, partMetadata);
}

export function createAssistantMessage(
  content: string,
  parentID: string,
  sessionID: string,
  partMetadata?: Message.TextPart["metadata"],
  timeCreated?: number,
): Message.WithParts {
  const id = crypto.randomUUID();
  const now = timeCreated ?? Date.now();
  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: now },
    parentID,
    modelID: "",
    providerID: "",
    agent: sessionID,
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  return withTextPart(info, content, partMetadata);
}

function withTextPart(
  info: Message.Info,
  content: string,
  metadata: Message.TextPart["metadata"],
): Message.WithParts {
  return {
    info,
    parts: [
      {
        id: crypto.randomUUID(),
        sessionID: info.sessionID,
        messageID: info.id,
        type: "text",
        text: content,
        ...(metadata === undefined ? {} : { metadata }),
      },
    ],
  };
}

/** Preserve durable prompt/result identity when hydrating its model projection. */
export function withMessageId(
  message: Message.WithParts,
  id: string | undefined,
): Message.WithParts {
  if (id === undefined) return message;
  return {
    info: { ...message.info, id },
    parts: message.parts.map((part, index) => ({
      ...part,
      id: `${id}:part:${index}`,
      messageID: id,
    })),
  };
}
