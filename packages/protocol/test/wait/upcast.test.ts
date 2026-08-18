import { describe, expect, test } from "bun:test";
import type { Communication } from "../../src/communication/index.js";
import { Wait } from "../../src/wait/index.js";

function buildInteraction(
  id: string,
  overrides: Partial<Communication.PendingInteraction.Record> = {},
): Communication.PendingInteraction.Record {
  return {
    id,
    workerRunId: `run-${id}`,
    sessionId: `session-${id}`,
    endpointId: "endpoint-1",
    channelId: "channel-1",
    correlation: {},
    allowedActions: ["report_result"],
    status: "open",
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 9_000,
    followUpWindow: 100,
    ...overrides,
  };
}

function buildAsk(
  id: string,
  overrides: Partial<Communication.PendingAsk.Record> = {},
): Communication.PendingAsk.Record {
  return {
    id,
    originSessionId: `session-${id}`,
    originRunId: `run-${id}`,
    originActorKind: "worker",
    targetKind: "external_actor",
    endpointId: "endpoint-1",
    channelId: "channel-1",
    correlation: {},
    status: "open",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("wait upcast — frozen PendingInteraction view", () => {
  test("maps a frozen row onto the Wait vocabulary without inventing fields", () => {
    const record = buildInteraction("pi-1", {
      targetActorId: "actor-a",
      correlation: { threadId: "thread-1", tokenHash: "token-1" },
    });
    const view = Wait.waitViewOfPendingInteraction(record);

    expect(view.id).toBe("pi-1");
    expect(view.ownerRef).toEqual({ kind: "session", id: "session-pi-1" });
    expect(view.originMessageId).toBe("legacy:pending_interaction:pi-1");
    expect(view.correlation).toEqual({
      endpointId: "endpoint-1",
      channelId: "channel-1",
      threadId: "thread-1",
      tokenHash: "token-1",
    });
    expect(view.expectedResponders).toEqual(["actor-a"]);
    expect(view.resolutionPolicy).toBe("first_reply");
    expect(view.status).toBe("open");
    expect(view.replies).toEqual([]);
    expect(view.revision).toBe(0);
  });

  test("falls back to the endpoint responder and folds every legacy status", () => {
    expect(Wait.waitViewOfPendingInteraction(buildInteraction("pi-2")).expectedResponders).toEqual([
      "endpoint-1",
    ]);
    const statusOf = (status: Communication.PendingInteraction.Status) =>
      Wait.waitViewOfPendingInteraction(
        buildInteraction("pi-status", {
          status,
          ...(status === "resolved" || status === "follow_up" ? { resolvedAt: 5 } : {}),
          ...(status === "cancelled" ? { cancelledAt: 6 } : {}),
        }),
      ).status;
    expect(statusOf("open")).toBe("open");
    expect(statusOf("resolved")).toBe("resolved");
    expect(statusOf("follow_up")).toBe("resolved");
    expect(statusOf("expired")).toBe("expired");
    expect(statusOf("cancelled")).toBe("cancelled");
  });
});

describe("wait upcast — frozen PendingAsk view", () => {
  test("keys the origin message off the external message id when present", () => {
    const view = Wait.waitViewOfPendingAsk(
      buildAsk("ask-1", {
        targetActorId: "actor-b",
        correlation: { externalMessageId: "ext-1", replyToMessageId: "reply-1" },
      }),
    );

    expect(view.originMessageId).toBe("ext-1");
    expect(view.correlation).toEqual({
      endpointId: "endpoint-1",
      channelId: "channel-1",
      replyToMessageId: "reply-1",
    });
    expect(view.expectedResponders).toEqual(["actor-b"]);
    expect(view.allowedActions).toEqual(["report_result"]);
    expect(view.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("keeps legacy ambiguous asks answerable and folds terminal statuses", () => {
    const statusOf = (status: Communication.PendingAsk.Status) =>
      Wait.waitViewOfPendingAsk(
        buildAsk("ask-status", {
          status,
          ...(status === "answered" ? { answeredAt: 7 } : {}),
        }),
      ).status;
    expect(statusOf("open")).toBe("open");
    expect(statusOf("ambiguous")).toBe("open");
    expect(statusOf("answered")).toBe("resolved");
    expect(statusOf("expired")).toBe("expired");
    expect(statusOf("cancelled")).toBe("cancelled");

    const synthetic = Wait.waitViewOfPendingAsk(buildAsk("ask-2"));
    expect(synthetic.originMessageId).toBe("legacy:pending_ask:ask-2");
    expect(synthetic.expectedResponders).toEqual(["endpoint-1"]);
  });
});
