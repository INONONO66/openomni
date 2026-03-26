import type { Messenger } from "@openomni/protocol";
import { AgentMessenger } from "./messenger";

export interface HistoryQueryOptions {
  timeRange?: { from?: number; to?: number };
  schemaRef?: string;
  traceId?: string;
  correlationId?: string | null;
  limit?: number;
  offset?: number;
}

export interface HistoryResult {
  messages: Messenger.MessageEnvelope[];
  total: number;
  hasMore: boolean;
}

export function queryHistory(agentId: string, options: HistoryQueryOptions = {}): HistoryResult {
  const { limit = 50, offset = 0 } = options;
  const all = AgentMessenger.getLog();

  const visible = all.filter((msg) => {
    if (msg.persistencePolicy === "asker_only") {
      if (msg.fromAgentId !== agentId && msg.toAgentId !== agentId) return false;
      if (msg.toAgentId === agentId && msg.fromAgentId !== agentId) return false;
    } else {
      if (msg.fromAgentId !== agentId && msg.toAgentId !== agentId) return false;
    }

    if (options.schemaRef && msg.schemaRef !== options.schemaRef) return false;
    if (options.traceId && msg.traceId !== options.traceId) return false;
    if (options.correlationId !== undefined && msg.correlationId !== options.correlationId)
      return false;
    if (options.timeRange?.from) {
      const sentAt = new Date(msg.sentAt).getTime();
      if (sentAt < options.timeRange.from) return false;
    }
    if (options.timeRange?.to) {
      const sentAt = new Date(msg.sentAt).getTime();
      if (sentAt > options.timeRange.to) return false;
    }

    return true;
  });

  const total = visible.length;
  const page = visible.slice(offset, offset + limit);

  return {
    messages: page,
    total,
    hasMore: offset + limit < total,
  };
}
