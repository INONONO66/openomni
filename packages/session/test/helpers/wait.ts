import { Wait } from "@openomni/protocol";
import type { Storage } from "../../src/index";

/**
 * Shared Wait fixture builder for session tests. Default input opens a
 * 2-of-3 quorum wait (expiresAt 10_000, followUpWindow 1_000).
 */
export function buildWaitCreate(overrides: Partial<Wait.Create> = {}): Wait.Create {
  return {
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
    expiresAt: 10_000,
    followUpWindow: 1_000,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

export function buildReplyInput(overrides: Partial<Wait.ReplyInput> = {}): Wait.ReplyInput {
  return {
    replyKey: "reply-key-1",
    responderCandidates: ["actor-a"],
    messageId: "in-msg-1",
    at: 1_000,
    ...overrides,
  };
}

/** Runs fn and returns the WaitStoreError it throws; fails when none is thrown. */
export function captureStoreError(fn: () => unknown): InstanceType<typeof Wait.StoreError> {
  try {
    fn();
  } catch (error) {
    if (Wait.StoreError.isInstance(error)) return error;
    throw error;
  }
  throw new Error("expected WaitStoreError, but nothing was thrown");
}

/**
 * Minimal Storage.Adapter without the wait sub-adapter, for the fail-closed
 * (adapter_absent) proof. Every other surface is unreachable in that test.
 */
export function bareStorageAdapter(): Storage.Adapter {
  const notImplemented = (): never => {
    throw new Error("bare test adapter: not implemented");
  };
  return {
    transaction: <T>(operation: () => T): T => operation(),
    session: {
      get: notImplemented,
      set: notImplemented,
      list: notImplemented,
      remove: notImplemented,
    },
    message: {
      get: notImplemented,
      set: notImplemented,
      list: notImplemented,
      remove: notImplemented,
    },
    part: {
      get: notImplemented,
      set: notImplemented,
      list: notImplemented,
      remove: notImplemented,
    },
  };
}
