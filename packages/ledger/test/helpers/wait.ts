import { Wait } from "@openomni/protocol";
import { type Storage, WaitStore } from "../../src/index";

/**
 * Shared Wait fixture builder for session tests. Default input opens a
 * 2-of-3 quorum wait (expiresAt 10_000, followUpWindow 1_000).
 */
export function buildWaitCreate(overrides: Partial<Wait.Create> = {}): Wait.Create {
  return {
    id: "wait-1",
    ownerRef: { kind: "session", id: "session-1" },
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

function requiredWait(id: string): Wait.Record {
  const record = WaitStore.get(id);
  if (record === undefined) {
    throw new Wait.StoreError({ message: `Wait not found: ${id}`, code: "not_found", waitId: id });
  }
  return record;
}

export function commitReply(id: string, input: Wait.ReplyInput, traceId: string): Wait.Outcome {
  const parsed = Wait.ReplyInput.parse(input);
  return WaitStore.commit(Wait.attachReply(requiredWait(id), parsed), traceId, parsed.replyKey);
}

export function commitCancel(id: string, traceId: string, at = Date.now()): Wait.Outcome {
  return WaitStore.commit(Wait.cancel(requiredWait(id), { at }), traceId);
}

export function commitExpiry(id: string, traceId: string, at = Date.now()): Wait.Outcome {
  return WaitStore.commit(Wait.expire(requiredWait(id), { at }), traceId);
}

export function commitDeliveryReceipt(
  id: string,
  input: Wait.DeliveryReceiptInput,
  traceId: string,
): Wait.Outcome {
  const parsed = Wait.DeliveryReceiptInput.parse(input);
  return WaitStore.commit(Wait.recordDeliveryReceipt(requiredWait(id), parsed), traceId);
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
  return { transaction: <T>(operation: () => T): T => operation() };
}
