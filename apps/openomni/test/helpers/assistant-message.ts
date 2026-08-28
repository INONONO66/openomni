import type { RunInput } from "@openomni/llm";
import type { Message } from "@openomni/protocol";

export interface AssistantMessageOptions {
  readonly call?: number;
  readonly createdAt?: number;
  readonly id?: string;
  readonly parts?: Message.WithParts["parts"];
  readonly reason?: string;
  readonly text?: string;
  readonly tokens?: Message.AssistantMessage["tokens"];
}

export function assistantMessage(
  input: RunInput,
  options: AssistantMessageOptions = {},
): Message.WithParts {
  const sessionID = input.trace.sessionId;
  const id =
    options.id ??
    (options.call === undefined
      ? `fake-${sessionID}-${input.messages.length}`
      : `assistant-${options.call}`);
  const tokens = options.tokens ?? {
    input: 4,
    output: 5,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  const text = options.text ?? (options.call === undefined ? "" : `reply ${options.call}`);
  const parts = options.parts ?? [
    { id: `${id}-text`, sessionID, messageID: id, type: "text" as const, text },
  ];

  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: options.createdAt ?? Date.now() },
      parentID: "",
      modelID: input.model.id,
      providerID: input.model.providerID,
      agent: "resident",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens,
    },
    parts: [
      ...parts.map((part) => ({ ...part, id: `${id}-${part.type}`, sessionID, messageID: id })),
      {
        id: `${id}-finish`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: options.reason ?? "stop",
        cost: 0,
        tokens,
      },
    ],
  };
}
