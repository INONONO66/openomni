import type { Message } from "@openomni/protocol";

export function createUserMessage(
  content: string,
  sessionID: string,
  partMetadata?: Record<string, unknown>,
  // #737: recorded creation time from the hydration record. Without it a
  // resumed message wears hydration time, and the next compaction cut would
  // stamp today's date onto yesterday's words.
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

  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text: content,
    ...(partMetadata === undefined ? {} : { metadata: partMetadata }),
  };

  return { info, parts: [textPart] };
}

export function createAssistantMessage(
  content: string,
  parentID: string,
  sessionID: string,
  partMetadata?: Record<string, unknown>,
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

  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text: content,
    ...(partMetadata === undefined ? {} : { metadata: partMetadata }),
  };

  return { info, parts: [textPart] };
}
