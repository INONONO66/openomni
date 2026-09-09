import type { Message, PlainObject } from "@openomni/protocol";

/** Deterministic protocol fixtures; callers own identity and message content. */
export function textMessage(
  role: "user" | "assistant",
  text: string,
  sessionID: string,
  id: string,
): Message.WithParts {
  const common = { id, sessionID, time: { created: 1 }, agent: "test" };
  const info: Message.Info =
    role === "user"
      ? { ...common, role, model: { providerID: "", modelID: "" } }
      : {
          ...common,
          role,
          parentID: "",
          modelID: "m",
          providerID: "p",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
  return {
    info,
    parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text }],
  };
}

export function completedToolPart(
  message: Message.WithParts,
  output: string,
  callID = `${message.info.id}-call`,
  input: PlainObject = {},
): Message.ToolPart {
  return {
    id: `${message.info.id}-tool`,
    sessionID: message.info.sessionID,
    messageID: message.info.id,
    type: "tool",
    callID,
    tool: "read_file",
    state: {
      status: "completed",
      input,
      output,
      title: "read_file",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}
