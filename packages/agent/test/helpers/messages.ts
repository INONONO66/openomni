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

/** An assistant message whose info carries `inputTokens` and whose parts are supplied by the caller. */
export function assistantWithParts(
  id: string,
  sessionID: string,
  parts: Message.Part[],
  inputTokens: number,
  outputTokens = 0,
): Message.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "model",
      providerID: "provider",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts,
  };
}

/** Id-sequenced user/assistant text messages for one session; `pad` is appended to assistant text. */
export function messageSequence(
  sessionID: string,
  pad = "",
): {
  user(text: string): Message.WithParts;
  assistant(text: string): Message.WithParts;
  nextId(prefix: string): string;
} {
  let counter = 0;
  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
  return {
    nextId,
    user: (text) => textMessage("user", text, sessionID, nextId("user-message")),
    assistant: (text) =>
      textMessage(
        "assistant",
        pad === "" ? text : `${text}${pad}`,
        sessionID,
        nextId("assistant-message"),
      ),
  };
}
