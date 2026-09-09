import { SessionHandleStore } from "@openomni/ledger";
import {
  Message,
  Tool,
  type LedgerAction,
  type PlainObject,
  type PlainValue,
} from "@openomni/protocol";
import { createAssistantMessage, createUserMessage, withMessageId } from "../core/message-factory";

/**
 * Canonical model-context fold over committed actions: delivered prompts,
 * assistant snapshots, positional tool settlements and compaction projections.
 * Originals and each replaced projection remain append-only; bus ticks, policy
 * decisions and diagnostics never enter model context.
 */
export function foldSessionHistory(
  sessionId: string,
  actions: readonly LedgerAction.Node[],
): Message.WithParts[] {
  let messages: Message.WithParts[] = [];
  let canonicalTurn = false;
  const byId = new Map(actions.map((action) => [action.id, action]));
  const messageTurns = new Map<string, string | null>();
  const turnOf = (action: LedgerAction.Node) => byId.get(action.parentId ?? "")?.parentId;
  for (const action of actions) {
    if (opensTurn(action)) canonicalTurn = false;
    const prompt = deliveredPrompt(action, sessionId);
    if (prompt !== undefined) messages.push(prompt);
    const snapshot = assistantSnapshot(action);
    if (snapshot !== undefined) {
      messageTurns.set(snapshot.info.id, turnOf(action) ?? null);
      messages = upsertMessage(messages, snapshot);
      canonicalTurn = true;
    }
    const projection = compactionProjection(action);
    if (projection !== undefined) messages = projection;
    const result = toolSettlement(action);
    if (result !== undefined) {
      const turnId = turnOf(action);
      messages = messages.map((message) =>
        messageTurns.get(message.info.id) !== turnId
          ? message
          : settleToolParts(message, result, action.ts),
      );
    }
    const terminal = SessionHandleStore.turnTerminal(action);
    if (terminal === undefined) continue;
    if (!canonicalTurn && terminal.text.length > 0)
      messages.push(
        terminalAssistant(terminal.text, messages.at(-1)?.info.id ?? "", sessionId, action),
      );
    if (terminal.kind === "interrupted" || terminal.kind === "error")
      messages = messages.map((message) => cancelOpenToolParts(message, terminal.kind, action.ts));
  }
  // An open turn can outlive its process between positional result commits.
  // Hydration never re-executes those calls; only slots without a settlement cancel.
  return messages.map((message) =>
    cancelOpenToolParts(message, "tool execution cancelled", message.info.time.created),
  );
}

/** A turn intent or resume starts a fresh turn: its assistant text is not yet canonical. */
function opensTurn(action: LedgerAction.Node): boolean {
  const intent = object(action.intent.value);
  return action.kind === "turn" && (intent.phase === "intent" || intent.phase === "resume");
}

/** A delivered prompt enters model context as the user message keyed by its inbox id. */
function deliveredPrompt(
  action: LedgerAction.Node,
  sessionId: string,
): Message.WithParts | undefined {
  const delivery = SessionHandleStore.delivery(action);
  if (delivery?.kind !== "prompt") return undefined;
  return withMessageId(
    createUserMessage(delivery.content, sessionId, undefined, action.ts),
    delivery.inboxId,
  );
}

/** An executed assistant message action carries the message snapshot as its result. */
function assistantSnapshot(action: LedgerAction.Node): Message.WithParts | undefined {
  const intent = object(action.intent.value);
  const effect = object(action.effect.value);
  if (action.kind !== "message" || intent.op !== "assistant") return undefined;
  if (effect.terminal !== "executed") return undefined;
  return Message.WithParts.parse(effect.result);
}

/** A snapshot replaces the message it re-states, or appends when it is new. */
function upsertMessage(
  messages: readonly Message.WithParts[],
  message: Message.WithParts,
): Message.WithParts[] {
  const index = messages.findIndex((existing) => existing.info.id === message.info.id);
  if (index < 0) return [...messages, message];
  return messages.map((existing, position) => (position === index ? message : existing));
}

/** An executed compaction replaces the whole context with its projection. */
function compactionProjection(action: LedgerAction.Node): Message.WithParts[] | undefined {
  const effect = object(action.effect.value);
  if (action.kind !== "compaction" || effect.terminal !== "executed") return undefined;
  const projection = object(effect.result).projection;
  if (!Array.isArray(projection)) return undefined;
  return projection.map((entry) => Message.WithParts.parse(entry));
}

/** A tool action with a committed result settles the matching tool part. */
function toolSettlement(action: LedgerAction.Node): Tool.Result | undefined {
  const effect = object(action.effect.value);
  if (action.kind !== "tool" || effect.toolResult === undefined) return undefined;
  return Tool.Result.parse(effect.toolResult);
}

type OpenToolPart = Message.ToolPart & {
  readonly state: Extract<Tool.State, { status: "pending" | "running" }>;
};

/** The part as a tool part still awaiting its settlement, or nothing for any other part. */
function openToolPart(part: Message.Part): OpenToolPart | undefined {
  if (part.type !== "tool") return undefined;
  const state = part.state;
  return state.status === "pending" || state.status === "running" ? { ...part, state } : undefined;
}

/** The settled state a result gives an open call: its error, or its output under the tool's title. */
function settledState(part: OpenToolPart, result: Tool.Result, at: number): Tool.State {
  const time = { start: at, end: at };
  return result.isError
    ? { status: "error", input: part.state.input, error: result.output, time }
    : {
        status: "completed",
        input: part.state.input,
        output: result.output,
        title: part.tool,
        metadata: {},
        time,
      };
}

/** Settle the open part this result names; every other part is untouched. */
function settleToolParts(
  message: Message.WithParts,
  result: Tool.Result,
  at: number,
): Message.WithParts {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const open = openToolPart(part);
      return open !== undefined &&
        open.callID === result.toolCallId &&
        open.tool === result.toolName
        ? { ...open, state: settledState(open, result, at) }
        : part;
    }),
  };
}

/** Every open tool part in the message fails with the given reason at the given time. */
function cancelOpenToolParts(
  message: Message.WithParts,
  error: string,
  at: number,
): Message.WithParts {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const open = openToolPart(part);
      if (open === undefined) return part;
      const state: Tool.State = {
        status: "error",
        input: open.state.input,
        error,
        time: { start: at, end: at },
      };
      return { ...open, state };
    }),
  };
}

/** A turn that ended without a canonical assistant snapshot contributes its terminal text. */
function terminalAssistant(
  text: string,
  parentId: string,
  sessionId: string,
  action: LedgerAction.Node,
): Message.WithParts {
  return withMessageId(
    createAssistantMessage(text, parentId, sessionId, undefined, action.ts),
    action.id,
  );
}

/** The value as a record, or an empty one: absent facts read as absent fields. */
function object(value: PlainValue | undefined): PlainObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
