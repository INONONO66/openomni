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

function anchorKeptIds(entry: StoredMessage): string[] | undefined {
  if (entry.info.role !== "user") return undefined;
  for (const part of entry.parts) {
    if (part.type !== "text" || part.metadata?.compactionAnchor !== true) continue;
    const kept = part.metadata?.keptMessageIds;
    if (!Array.isArray(kept)) continue;
    return kept.filter((id): id is string => typeof id === "string");
  }
  return undefined;
}

/**
 * #702: consume the latest replacement record. Compaction persists its
 * anchor message (metadata: ordered kept-message ids) at the apply seam;
 * every hydration path funnels through here, so the model window resumes as
 * [anchor, kept ids in recorded order, everything stored after the anchor]
 * instead of re-inflating the full pre-compaction history. Kept ids that no
 * longer resolve are skipped — a message that never reached the store
 * (resident intermediates) was never resumable to begin with. Absent a
 * record, behavior is unchanged.
 */
function selectWindow(stored: StoredMessage[]): StoredMessage[] {
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    const entry = stored[index];
    if (entry === undefined) continue;
    const keptIds = anchorKeptIds(entry);
    if (keptIds === undefined) continue;
    const byId = new Map(stored.map((candidate) => [candidate.info.id, candidate]));
    const keptSet = new Set(keptIds);
    const kept = keptIds
      .map((id) => byId.get(id))
      .filter((candidate): candidate is StoredMessage => candidate !== undefined);
    const after = stored.slice(index + 1).filter((candidate) => !keptSet.has(candidate.info.id));
    return [entry, ...kept, ...after];
  }
  return stored;
}

export namespace SessionBridge {
  export function buildDirectMessages(
    sessionId: string,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const stored: StoredMessage[] = Session.getMessages(sessionId).map((info) => ({
      info,
      parts: Session.getParts(info.id),
    }));
    const result: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const message of selectWindow(stored)) {
      for (const part of message.parts) {
        if (part.type === "text" && !part.text.startsWith(LEGACY_PLAN_MARKER)) {
          result.push({ role: message.info.role, content: part.text });
        }
      }
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
