import type { Communication } from "../communication/index.js";
import { Record, type Status } from "./schema.js";

/**
 * Read-only Wait views over frozen legacy rows (#215): persisted
 * PendingInteraction / PendingAsk records map onto the single Wait vocabulary
 * so correlation resolves every waiting representation through one shape.
 * This module NEVER writes legacy stores — destructive migration is a #215
 * non-goal and legacy rows stay readable exactly as persisted. Pure protocol
 * folds: record in, view out, no store access.
 */

function pendingInteractionStatus(status: Communication.PendingInteraction.Status): Status {
  switch (status) {
    case "open":
      return "open";
    case "resolved":
    case "follow_up":
      return "resolved";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
  }
}

export function waitViewOfPendingInteraction(
  record: Communication.PendingInteraction.Record,
): Record {
  return Record.parse({
    id: record.id,
    ownerRef: { kind: "session", id: record.sessionId },
    // Legacy rows predate the awaited-message ledger; the synthetic origin id
    // keeps the view parseable without inventing a message that never existed.
    originMessageId: `legacy:pending_interaction:${record.id}`,
    correlation: {
      endpointId: record.endpointId,
      channelId: record.channelId,
      ...record.correlation,
    },
    allowedActions: record.allowedActions,
    expectedResponders: [record.targetActorId ?? record.endpointId],
    resolutionPolicy: "first_reply",
    status: pendingInteractionStatus(record.status),
    partial: false,
    replies: [],
    revision: 0,
    expiresAt: record.expiresAt,
    followUpWindow: record.followUpWindow,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
    ...(record.cancelledAt === undefined ? {} : { cancelledAt: record.cancelledAt }),
  });
}

function pendingAskStatus(status: Communication.PendingAsk.Status): Status {
  switch (status) {
    case "open":
    // Legacy "ambiguous" asks stayed answerable (answer() accepted them), so
    // the view keeps them open for correlation.
    case "ambiguous":
      return "open";
    case "answered":
      return "resolved";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
  }
}

export function waitViewOfPendingAsk(record: Communication.PendingAsk.Record): Record {
  return Record.parse({
    id: record.id,
    ownerRef: { kind: "session", id: record.originSessionId },
    originMessageId: record.correlation.externalMessageId ?? `legacy:pending_ask:${record.id}`,
    correlation: {
      ...(record.endpointId === undefined ? {} : { endpointId: record.endpointId }),
      ...(record.channelId === undefined ? {} : { channelId: record.channelId }),
      ...(record.correlation.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: record.correlation.replyToMessageId }),
      ...(record.correlation.threadId === undefined
        ? {}
        : { threadId: record.correlation.threadId }),
      ...(record.correlation.tokenHash === undefined
        ? {}
        : { tokenHash: record.correlation.tokenHash }),
      ...(record.correlation.externalConversationId === undefined
        ? {}
        : { externalConversationId: record.correlation.externalConversationId }),
    },
    // Legacy asks accepted any correlated inbound as the answer; the routed
    // read path never consults these two fields, they only satisfy the view
    // shape (routing pins the origin session instead of matching a sender).
    allowedActions: ["report_result"],
    expectedResponders: [record.targetActorId ?? record.endpointId ?? record.originSessionId],
    resolutionPolicy: "first_reply",
    status: pendingAskStatus(record.status),
    partial: false,
    replies: [],
    revision: 0,
    expiresAt: record.expiresAt ?? Number.MAX_SAFE_INTEGER,
    followUpWindow: 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.answeredAt === undefined ? {} : { resolvedAt: record.answeredAt }),
  });
}
