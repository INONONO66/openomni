import { z } from "zod";
import type * as Schema from "./schema.js";

/**
 * Pure deterministic Wait state machine (#215). Time (`at`) and reply
 * identity (`replyKey`, `responderCandidates`) are inputs — no Date.now(),
 * no randomness. Every transition returns a typed Outcome; callers branch on
 * `kind`/`code`, never on message text.
 *
 * attachReply rule order is pinned (each earlier rule wins):
 *   1. duplicate replyKey       -> rejected duplicate_reply (idempotent, any status)
 *   2. terminal status          -> follow-up attach when resolved and inside
 *                                  the follow-up window, else rejected late_reply
 *   3. deadline passed          -> rejected deadline_passed (open, at > expiresAt)
 *   4. responder identity       -> rejected unknown_responder / ambiguous_responder
 *   5. attach                   -> resolved at quorum threshold, else attached
 */

export const ReplyInput = z
  .object({
    replyKey: z.string().min(1),
    /**
     * Expected-responder ids the sender matcher resolved the inbound sender
     * to. Zero matches is unknown; more than one is ambiguous — the fold
     * never guesses.
     */
    responderCandidates: z.array(z.string().min(1)).min(1),
    messageId: z.string().min(1).optional(),
    at: z.number(),
  })
  .strict();
export type ReplyInput = z.infer<typeof ReplyInput>;

export const RejectionCode = z.enum([
  "duplicate_reply",
  "late_reply",
  "deadline_passed",
  "unknown_responder",
  "ambiguous_responder",
  "not_expired",
  "wait_terminal",
]);
export type RejectionCode = z.infer<typeof RejectionCode>;

export type Outcome =
  | {
      kind: "attached";
      record: Schema.Record;
      reply: Schema.Reply;
      responders: number;
      threshold: number;
      /** True when the reply attached as supplementary information after resolution. */
      followUp: boolean;
    }
  | {
      kind: "resolved";
      record: Schema.Record;
      reply: Schema.Reply;
      responders: number;
      threshold: number;
    }
  | { kind: "expired"; record: Schema.Record; partial: boolean }
  | { kind: "cancelled"; record: Schema.Record }
  | { kind: "rejected"; code: RejectionCode; record: Schema.Record; at: number };

export function effectiveThreshold(record: Schema.Record): number {
  switch (record.resolutionPolicy) {
    case "first_reply":
      return 1;
    case "all":
      return record.expectedResponders.length;
    case "quorum":
      return requireQuorum(record).threshold;
  }
}

function requireQuorum(record: Schema.Record): Schema.Quorum {
  // Presence is guaranteed by the schema layer (Record's resolution
  // refinement); this narrows the optional type without a silent fallback.
  if (record.quorum === undefined) {
    throw new Error("Wait resolutionPolicy=quorum without quorum bounds — schema layer regressed");
  }
  return record.quorum;
}

function respondedCount(replies: readonly Schema.Reply[]): number {
  return new Set(replies.map((reply) => reply.responderId)).size;
}

export function attachReply(record: Schema.Record, input: ReplyInput): Outcome {
  if (record.replies.some((reply) => reply.replyKey === input.replyKey)) {
    return { kind: "rejected", code: "duplicate_reply", record, at: input.at };
  }
  if (record.status !== "open") {
    const withinFollowUp =
      record.status === "resolved" &&
      record.resolvedAt !== undefined &&
      input.at <= record.resolvedAt + record.followUpWindow;
    if (withinFollowUp) {
      return matchAndAttach(record, input, true);
    }
    return { kind: "rejected", code: "late_reply", record, at: input.at };
  }
  if (input.at > record.expiresAt) {
    return { kind: "rejected", code: "deadline_passed", record, at: input.at };
  }
  return matchAndAttach(record, input, false);
}

function matchAndAttach(record: Schema.Record, input: ReplyInput, followUp: boolean): Outcome {
  const expected = new Set(record.expectedResponders);
  const matched = Array.from(new Set(input.responderCandidates)).filter((candidate) =>
    expected.has(candidate),
  );
  const [responderId, ...extraMatches] = matched;
  if (responderId === undefined) {
    return { kind: "rejected", code: "unknown_responder", record, at: input.at };
  }
  if (extraMatches.length > 0) {
    return { kind: "rejected", code: "ambiguous_responder", record, at: input.at };
  }

  const reply: Schema.Reply = {
    replyKey: input.replyKey,
    responderId,
    messageId: input.messageId,
    receivedAt: input.at,
  };
  const replies = [...record.replies, reply];
  // Quorum counts distinct responders: a second reply from an already-counted
  // responder attaches but never advances the count.
  const responders = respondedCount(replies);
  const threshold = effectiveThreshold(record);

  if (followUp) {
    return {
      kind: "attached",
      record: { ...record, replies, revision: record.revision + 1, updatedAt: input.at },
      reply,
      responders,
      threshold,
      followUp: true,
    };
  }
  if (responders >= threshold) {
    return {
      kind: "resolved",
      record: {
        ...record,
        replies,
        status: "resolved",
        partial: false,
        resolvedAt: input.at,
        revision: record.revision + 1,
        updatedAt: input.at,
      },
      reply,
      responders,
      threshold,
    };
  }
  return {
    kind: "attached",
    record: { ...record, replies, revision: record.revision + 1, updatedAt: input.at },
    reply,
    responders,
    threshold,
    followUp: false,
  };
}

export function expire(record: Schema.Record, input: { at: number }): Outcome {
  if (record.status !== "open") {
    return { kind: "rejected", code: "wait_terminal", record, at: input.at };
  }
  if (input.at <= record.expiresAt) {
    return { kind: "rejected", code: "not_expired", record, at: input.at };
  }
  // Partial expiry: some-but-not-all replies arrived (quorum unmet is implied
  // by the record still being open).
  const partial = record.replies.length > 0;
  return {
    kind: "expired",
    record: {
      ...record,
      status: "expired",
      partial,
      revision: record.revision + 1,
      updatedAt: input.at,
    },
    partial,
  };
}

export function cancel(record: Schema.Record, input: { at: number }): Outcome {
  if (record.status !== "open") {
    return { kind: "rejected", code: "wait_terminal", record, at: input.at };
  }
  return {
    kind: "cancelled",
    record: {
      ...record,
      status: "cancelled",
      cancelledAt: input.at,
      revision: record.revision + 1,
      updatedAt: input.at,
    },
  };
}
