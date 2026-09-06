import { SessionHandleStore } from "@openomni/ledger";
import { Message, Tool, type LedgerAction } from "@openomni/protocol";
import { createAssistantMessage, createUserMessage, withMessageId } from "./core/message-factory";

/** Canonical context projection; originals and each replaced projection remain append-only. */
export function sessionHistory(
  sessionId: string,
  actions: readonly LedgerAction.Node[],
): Message.WithParts[] {
  let messages: Message.WithParts[] = [];
  let canonicalTurn = false;
  const byId = new Map(actions.map((action) => [action.id, action]));
  const messageTurns = new Map<string, string | null>();
  for (const action of actions) {
    const intent = action.intent.value;
    const effect = action.effect.value;
    if (
      action.kind === "turn" &&
      object(intent) &&
      (intent.phase === "intent" || intent.phase === "resume")
    )
      canonicalTurn = false;
    const delivery = SessionHandleStore.delivery(action);
    if (delivery?.kind === "prompt")
      messages.push(
        withMessageId(
          createUserMessage(delivery.content, sessionId, undefined, action.ts),
          delivery.inboxId,
        ),
      );
    if (
      action.kind === "message" &&
      object(intent) &&
      intent.op === "assistant" &&
      object(effect) &&
      effect.terminal === "executed"
    ) {
      const message = Message.WithParts.parse(effect.result);
      messageTurns.set(message.info.id, byId.get(action.parentId ?? "")?.parentId ?? null);
      const index = messages.findIndex((existing) => existing.info.id === message.info.id);
      if (index < 0) messages.push(message);
      else messages[index] = message;
      canonicalTurn = true;
    }
    if (
      action.kind === "compaction" &&
      object(effect) &&
      effect.terminal === "executed" &&
      object(effect.result) &&
      Array.isArray(effect.result.projection)
    ) {
      messages = effect.result.projection.map((entry) => Message.WithParts.parse(entry));
    }
    if (action.kind === "tool" && object(effect) && effect.toolResult !== undefined) {
      const result = Tool.Result.parse(effect.toolResult);
      const turnId = byId.get(action.parentId ?? "")?.parentId;
      messages = messages.map((message) =>
        messageTurns.get(message.info.id) !== turnId
          ? message
          : {
              ...message,
              parts: message.parts.map((part) =>
                part.type === "tool" &&
                part.callID === result.toolCallId &&
                part.tool === result.toolName &&
                (part.state.status === "pending" || part.state.status === "running")
                  ? {
                      ...part,
                      state: result.isError
                        ? {
                            status: "error" as const,
                            input: part.state.input,
                            error: result.output,
                            time: { start: action.ts, end: action.ts },
                          }
                        : {
                            status: "completed" as const,
                            input: part.state.input,
                            output: result.output,
                            title: part.tool,
                            metadata: {},
                            time: { start: action.ts, end: action.ts },
                          },
                    }
                  : part,
              ),
            },
      );
    }
    const terminal = SessionHandleStore.turnTerminal(action);
    if (terminal === undefined) continue;
    if (!canonicalTurn && terminal.text.length > 0)
      messages.push(
        withMessageId(
          createAssistantMessage(
            terminal.text,
            messages.at(-1)?.info.id ?? "",
            sessionId,
            undefined,
            action.ts,
          ),
          action.id,
        ),
      );
    if (terminal.kind === "interrupted" || terminal.kind === "error")
      messages = messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "tool" &&
          (part.state.status === "pending" || part.state.status === "running")
            ? {
                ...part,
                state: {
                  status: "error" as const,
                  input: part.state.input,
                  error: terminal.kind,
                  time: { start: action.ts, end: action.ts },
                },
              }
            : part,
        ),
      }));
  }
  // An open turn can outlive its process between positional result commits.
  // Hydration never re-executes those calls; only slots without a settlement cancel.
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")
        ? {
            ...part,
            state: {
              status: "error" as const,
              input: part.state.input,
              error: "tool execution cancelled",
              time: { start: message.info.time.created, end: message.info.time.created },
            },
          }
        : part,
    ),
  }));
}

function object(
  value: import("@openomni/protocol").PlainValue | undefined,
): value is import("@openomni/protocol").PlainObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}
