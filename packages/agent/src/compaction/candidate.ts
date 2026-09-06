import type { Message } from "@openomni/protocol";
import type { CompactionCandidate } from "./speculate";

/**
 * The anchored-cut plan, shared by the seam and the speculator (L4): which
 * span a cut would summarize right now, by id, with the exclusions the L2
 * contract owns (user messages and prior anchor renders never reach the
 * summarizer). Pure — no elision, no events, no rebuild.
 */
export function planAnchoredCut(
  messages: readonly Message.WithParts[],
  protectRecentMessages: number,
):
  | {
      readonly prefixIds: readonly string[];
      readonly prefixFingerprint: string;
      readonly previousAnchor: string | undefined;
      readonly summarizerInput: Message.WithParts[];
    }
  | undefined {
  if (messages.length <= protectRecentMessages) return undefined;
  const cutoff = messages.length - protectRecentMessages;
  if (cutoff <= 0) return undefined;
  const toRemove = messages.slice(0, cutoff);
  return {
    prefixIds: toRemove.map((message) => message.info.id),
    prefixFingerprint: canonicalPrefixFingerprint(toRemove),
    previousAnchor: latestAnchorBody(toRemove),
    summarizerInput: toRemove.filter(
      (message) => message.info.role !== "user" && !isAnchorMessage(message),
    ),
  };
}

/**
 * Anchor identity is structural — the metadata flag, never string-matching
 * on the render — so later render decoration (L6: artifact table, goal
 * recitation) cannot break extraction. `anchorBody` in metadata is the raw
 * merge state the next cut threads back into the summarizer; the part text
 * is its model-facing render.
 */
export function isAnchorMessage(message: Message.WithParts): boolean {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => part.type === "text" && part.metadata?.compactionAnchor === true)
  );
}

export function latestCompactionAnchorId(span: readonly Message.WithParts[]): string | undefined {
  for (let index = span.length - 1; index >= 0; index -= 1) {
    const message = span[index];
    if (message !== undefined && isAnchorMessage(message)) return message.info.id;
  }
  return undefined;
}

export function isWarmCandidateValid(
  candidate: CompactionCandidate,
  messages: readonly Message.WithParts[],
): boolean {
  const cut = messages.findIndex((message) => message.info.id === candidate.firstKeptId);
  if (cut !== candidate.prefixIds.length) return false;
  if (latestCompactionAnchorId(messages) !== candidate.compactionAnchorId) return false;
  if (!candidate.prefixIds.every((id, index) => messages[index]?.info.id === id)) return false;
  return (
    canonicalPrefixFingerprint(messages.slice(0, candidate.prefixIds.length)) ===
    candidate.prefixFingerprint
  );
}

function canonicalPartContent(part: Message.Part): unknown {
  if (part.type === "text") return { type: part.type, text: part.text, metadata: part.metadata };
  if (part.type === "reasoning") {
    return { type: part.type, text: part.text, signature: part.signature, metadata: part.metadata };
  }
  if (part.type === "step-start") return { type: part.type };
  if (part.type === "step-finish") {
    return { type: part.type, reason: part.reason, cost: part.cost, tokens: part.tokens };
  }
  const state =
    part.state.status === "completed" ? { ...part.state, output: "[tool output]" } : part.state;
  return { type: part.type, callID: part.callID, tool: part.tool, state };
}

function canonicalPrefixFingerprint(messages: readonly Message.WithParts[]): string {
  const canonical = JSON.stringify(
    messages.map((message) => ({
      role: message.info.role,
      parts: message.parts.map(canonicalPartContent),
    })),
  );
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function latestAnchorBody(span: readonly Message.WithParts[]): string | undefined {
  for (let index = span.length - 1; index >= 0; index -= 1) {
    // The parameter is a dense Message.WithParts[] assembled by slice/spread;
    // an in-bounds element is therefore present.
    const message = span[index] as Message.WithParts;
    // One identity, one definition (review #721 M3): only what
    // isAnchorMessage accepts may thread its body — an assistant-role part
    // wearing the metadata is content, never state.
    if (!isAnchorMessage(message)) continue;
    // isAnchorMessage just proved this element exists; repeat the predicate
    // only to retrieve it, not as a second impossible fallback branch.
    const part = message.parts.find(
      (candidate): candidate is Message.TextPart =>
        candidate.type === "text" && candidate.metadata?.compactionAnchor === true,
    ) as Message.TextPart;
    const body = part.metadata?.anchorBody;
    // A marked part without a string body is a foreign or corrupt render:
    // fall back to the visible text rather than dropping the anchor.
    return typeof body === "string" ? body : part.text;
  }
  return undefined;
}
