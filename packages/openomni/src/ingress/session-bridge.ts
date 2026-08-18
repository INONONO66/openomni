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

interface StoredMessage {
  readonly info: Message.Info;
  readonly parts: Message.Part[];
}

interface DirectMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

function isKeptEntry(value: unknown): value is DirectMessage {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { role?: unknown; text?: unknown };
  return (
    (entry.role === "user" || entry.role === "assistant") &&
    typeof (entry as { text?: unknown }).text === "string"
  );
}

function anchorKeptWindow(entry: StoredMessage): DirectMessage[] | undefined {
  if (entry.info.role !== "user") return undefined;
  for (const part of entry.parts) {
    if (part.type !== "text" || part.metadata?.compactionAnchor !== true) continue;
    const kept = part.metadata?.keptWindow;
    if (!Array.isArray(kept)) continue;
    return kept
      .filter(isKeptEntry)
      .map((item) => ({ role: item.role, content: (item as unknown as { text: string }).text }));
  }
  return undefined;
}

function pushTextParts(target: DirectMessage[], message: StoredMessage): void {
  for (const part of message.parts) {
    if (part.type === "text" && !part.text.startsWith(LEGACY_PLAN_MARKER)) {
      target.push({ role: message.info.role, content: part.text });
    }
  }
}

/**
 * #702: consume the latest replacement record. Compaction persists its
 * anchor message — whose part metadata carries the ordered kept CONTENT
 * (role/content, not ids: hydration flattens to strings and the run
 * re-mints ids, so an id record resolves to nothing; #722 review) — and
 * every hydration path funnels through here. The window resumes as
 * [anchor render, kept content in recorded order, everything stored after
 * the anchor] instead of re-inflating the full pre-compaction history.
 * Absent a record, behavior is unchanged.
 */
function buildFromRecord(stored: StoredMessage[]): DirectMessage[] | undefined {
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    const entry = stored[index];
    if (entry === undefined) continue;
    const kept = anchorKeptWindow(entry);
    if (kept === undefined) continue;
    const result: DirectMessage[] = [];
    pushTextParts(result, entry);
    for (const item of kept) {
      if (!item.content.startsWith(LEGACY_PLAN_MARKER)) result.push(item);
    }
    for (const later of stored.slice(index + 1)) {
      pushTextParts(result, later);
    }
    return result;
  }
  return undefined;
}

export namespace SessionBridge {
  export function buildDirectMessages(sessionId: string): DirectMessage[] {
    const stored: StoredMessage[] = Session.getMessages(sessionId).map((info) => ({
      info,
      parts: Session.getParts(info.id),
    }));

    const fromRecord = buildFromRecord(stored);
    if (fromRecord !== undefined) return fromRecord;

    const result: DirectMessage[] = [];
    for (const message of stored) {
      pushTextParts(result, message);
    }
    return result;
  }

  export function storeDirectResult(
    traceId: string,
    sessionId: string,
    output: string,
    model: Model.Ref,
  ): void {
    const message = createAssistantMessage(sessionId, model);
    const part: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: output,
    };

    const audit = createIngressAudit(traceId, sessionId, "session_bridge");
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
