import { Wait } from "../../src/wait/index.js";

/**
 * Shared Wait fixture builder for protocol tests. Default record is an open
 * 2-of-3 quorum wait (expiresAt 10_000, followUpWindow 1_000).
 */
export function buildWaitRecord(overrides: Partial<Wait.Record> = {}): Wait.Record {
  return Wait.Record.parse({
    id: "wait-1",
    ownerRef: { kind: "workItem", id: "wi-1" },
    originMessageId: "out-msg-1",
    correlation: {
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      replyToMessageId: "reply-1",
      tokenHash: "tok-1",
    },
    allowedActions: ["report_result", "ask_clarification"],
    expectedResponders: ["actor-a", "actor-b", "actor-c"],
    resolutionPolicy: "quorum",
    quorum: { expected: 3, threshold: 2 },
    status: "open",
    partial: false,
    replies: [],
    revision: 0,
    expiresAt: 10_000,
    followUpWindow: 1_000,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  });
}

export function buildReplyInput(overrides: Partial<Wait.ReplyInput> = {}): Wait.ReplyInput {
  return Wait.ReplyInput.parse({
    replyKey: "reply-key-1",
    responderCandidates: ["actor-a"],
    messageId: "in-msg-1",
    at: 1_000,
    ...overrides,
  });
}
