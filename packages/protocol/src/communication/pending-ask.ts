import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { NamedError } from "../error/index.js";

export const Status = z.enum(["open", "answered", "expired", "cancelled", "ambiguous"]);
export type Status = z.infer<typeof Status>;

export const TargetKind = z.enum(["resident", "worker", "external_actor", "scheduler", "service"]);
export type TargetKind = z.infer<typeof TargetKind>;

export const Record = z
  .object({
    id: z.string().min(1),
    originSessionId: z.string().min(1),
    originRunId: z.string().min(1).optional(),
    originActorKind: z.enum(["resident", "worker", "system"]),
    targetKind: TargetKind,
    targetActorId: z.string().min(1).optional(),
    endpointId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    correlation: z
      .object({
        externalMessageId: z.string().min(1).optional(),
        replyToMessageId: z.string().min(1).optional(),
        threadId: z.string().min(1).optional(),
        tokenHash: z.string().min(1).optional(),
        externalConversationId: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    status: Status,
    createdAt: z.number(),
    expiresAt: z.number().optional(),
    answeredAt: z.number().optional(),
    updatedAt: z.number(),
  })
  .strict();
export type Record = z.infer<typeof Record>;

export const Create = Record.omit({
  status: true,
  createdAt: true,
  updatedAt: true,
  answeredAt: true,
}).extend({
  status: Status.optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
export type Create = z.infer<typeof Create>;

export const WriteMethod = z.enum(["create", "answer", "markAmbiguous", "cancel", "expire"]);
export type WriteMethod = z.infer<typeof WriteMethod>;

/**
 * #510 D2a — PendingAsk is a frozen legacy writer. Its final accepted append
 * predates the freeze (#215 already retired every production write path), so
 * every `PendingAskStore` write method throws this typed error. Callers
 * branch on `data.code`, never message text. Historical rows stay readable
 * through the store's read methods and the upcast-on-read Wait view; the
 * archive manifest (script/generate-ledger-archive-manifest.ts) records
 * their range identity and integrity hash.
 */
export const FrozenError = NamedError.create(
  "PendingAskFrozenError",
  z.object({
    message: z.string(),
    code: z.literal("pending_ask_frozen"),
    method: WriteMethod,
  }),
);

export const CorrelationQuery = z
  .object({
    externalMessageId: z.string().min(1).optional(),
    replyToMessageId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    tokenHash: z.string().min(1).optional(),
    externalConversationId: z.string().min(1).optional(),
    endpointId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
  })
  .strict()
  .refine((query) => Object.values(query).some((value) => value !== undefined), {
    message: "At least one correlation field is required",
  });
export type CorrelationQuery = z.infer<typeof CorrelationQuery>;

const EventBase = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  status: Status,
  originSessionId: z.string().min(1),
  originRunId: z.string().min(1).optional(),
  targetKind: TargetKind,
  time: z.number(),
});

export const Events = {
  Opened: BusEvent.define("pending_ask.opened", EventBase, { visibility: "internal" }),
  Answered: BusEvent.define("pending_ask.answered", EventBase.extend({ answeredAt: z.number() }), {
    visibility: "internal",
  }),
  Ambiguous: BusEvent.define("pending_ask.ambiguous", EventBase, { visibility: "internal" }),
  Cancelled: BusEvent.define("pending_ask.cancelled", EventBase, { visibility: "internal" }),
  Expired: BusEvent.define("pending_ask.expired", EventBase, { visibility: "internal" }),
} as const;
