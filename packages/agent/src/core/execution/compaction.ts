import type { Message } from "@openomni/protocol";

export interface CompactionOptions {
  contextWindowTokens: number;
  thresholdRatio?: number;
  protectRecentMessages?: number;
  onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
}

export interface CompactionResult {
  messages: Message.WithParts[];
  compacted: boolean;
  removedCount: number;
}

const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_PROTECT_RECENT = 6;

export namespace InMemoryCompactor {
  export function shouldCompact(totalTokens: number, options: CompactionOptions): boolean {
    const threshold =
      options.contextWindowTokens * (options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO);
    return totalTokens >= threshold;
  }

  export async function compact(
    messages: Message.WithParts[],
    options: CompactionOptions,
  ): Promise<CompactionResult> {
    const protectRecent = options.protectRecentMessages ?? DEFAULT_PROTECT_RECENT;

    if (messages.length <= protectRecent) {
      return { messages, compacted: false, removedCount: 0 };
    }

    const cutoff = messages.length - protectRecent;
    const toRemove = messages.slice(0, cutoff);
    const toKeep = messages.slice(cutoff);

    let summaryMessages: Message.WithParts[] = [];
    if (options.onSummarize && toRemove.length > 0) {
      const summaryText = await options.onSummarize(toRemove);
      summaryMessages = [buildSummaryMessage(summaryText)];
    }

    const compacted = [...summaryMessages, ...toKeep];

    return {
      messages: compacted,
      compacted: true,
      removedCount: toRemove.length,
    };
  }
}

function buildSummaryMessage(summaryText: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "chat-agent";
  const now = Date.now();
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: now },
    agent: "chat-agent",
    model: { providerID: "", modelID: "" },
    system: `[Conversation Summary]\n${summaryText}`,
  };
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text: `[Conversation Summary]\n${summaryText}`,
  };
  return { info, parts: [textPart] };
}
