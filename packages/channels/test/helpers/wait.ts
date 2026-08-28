import type { Wait } from "@openomni/protocol";

/** Shared Wait-domain fixture builders for openomni tests (#215). */

export const correlationFixture = Object.freeze({
  endpointId: "endpoint-1",
  channelId: "channel-1",
  replyToMessageId: "reply-1",
  threadId: "thread-1",
  tokenHash: "token-1",
  externalConversationId: "conversation-1",
}) satisfies Wait.Correlation;

export function buildWaitRecord(id: string, overrides: Partial<Wait.Record> = {}): Wait.Record {
  return {
    id,
    ownerRef: { kind: "session", id: `session-${id}` },
    originMessageId: `out-${id}`,
    correlation: {
      endpointId: correlationFixture.endpointId,
      channelId: correlationFixture.channelId,
      tokenHash: correlationFixture.tokenHash,
    },
    allowedActions: ["report_result"],
    expectedResponders: [`actor-${id}`],
    resolutionPolicy: "first_reply",
    status: "open",
    partial: false,
    replies: [],
    revision: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    followUpWindow: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function buildWaitCreate(id: string, overrides: Partial<Wait.Create> = {}): Wait.Create {
  return {
    id,
    ownerRef: { kind: "session", id: `session-${id}` },
    originMessageId: `out-${id}`,
    correlation: {
      endpointId: correlationFixture.endpointId,
      channelId: correlationFixture.channelId,
      tokenHash: correlationFixture.tokenHash,
    },
    allowedActions: ["report_result"],
    expectedResponders: [`actor-${id}`],
    resolutionPolicy: "first_reply",
    expiresAt: Number.MAX_SAFE_INTEGER,
    followUpWindow: 0,
    ...overrides,
  };
}
