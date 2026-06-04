import { z } from "zod";
import { BusEvent } from "../bus/index.js";

export namespace Communication {
  export const Envelope = z
    .object({
      id: z.string().min(1),
      direction: z.enum(["inbound", "outbound"]),
      surface: z.string().min(1),
      endpointId: z.string().min(1).optional(),
      channelId: z.string().min(1).optional(),
      threadId: z.string().min(1).optional(),
      externalMessageId: z.string().min(1).optional(),
      replyToMessageId: z.string().min(1).optional(),
      correlationToken: z.string().min(1).optional(),
      actorId: z.string().min(1).optional(),
      payload: z.unknown(),
      receivedAt: z.number().optional(),
      sentAt: z.number().optional(),
    })
    .strict();
  export type Envelope = z.infer<typeof Envelope>;

  export namespace PendingAsk {
    export const Status = z.enum(["open", "answered", "expired", "cancelled", "ambiguous"]);
    export type Status = z.infer<typeof Status>;

    export const TargetKind = z.enum([
      "resident",
      "worker",
      "external_actor",
      "scheduler",
      "service",
    ]);
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
      status: Status,
      originSessionId: z.string().min(1),
      originRunId: z.string().min(1).optional(),
      targetKind: TargetKind,
      time: z.number(),
    });

    export namespace Events {
      export const Opened = BusEvent.define("pending_ask.opened", EventBase);
      export const Answered = BusEvent.define(
        "pending_ask.answered",
        EventBase.extend({ answeredAt: z.number() }),
      );
      export const Ambiguous = BusEvent.define("pending_ask.ambiguous", EventBase);
      export const Cancelled = BusEvent.define("pending_ask.cancelled", EventBase);
      export const Expired = BusEvent.define("pending_ask.expired", EventBase);
    }
  }

  export namespace WorkerGrant {
    export const Status = z.enum(["active", "revoked", "expired"]);
    export type Status = z.infer<typeof Status>;

    export const Risk = z.enum(["low", "medium", "high"]);
    export type Risk = z.infer<typeof Risk>;

    export const ManagerGrant = z
      .object({
        allowedActorGroups: z.array(z.string().min(1)).optional(),
        riskCeiling: Risk.optional(),
      })
      .strict();
    export type ManagerGrant = z.infer<typeof ManagerGrant>;

    export const Record = z
      .object({
        id: z.string().min(1),
        workerRunId: z.string().min(1),
        status: Status,
        version: z.number().int().min(1),
        allowedActions: z.array(z.string().min(1)),
        allowedSessionIds: z.array(z.string().min(1)).optional(),
        allowedActorIds: z.array(z.string().min(1)).optional(),
        allowedEndpointIds: z.array(z.string().min(1)).optional(),
        canCreateExternalTasks: z.boolean().default(false),
        managerGrant: ManagerGrant.optional(),
        createdAt: z.number(),
        updatedAt: z.number(),
        expiresAt: z.number().optional(),
        revokedAt: z.number().optional(),
      })
      .strict();
    export type Record = z.infer<typeof Record>;

    export const Create = Record.omit({
      status: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      revokedAt: true,
    }).extend({
      status: Status.optional(),
      version: z.number().int().min(1).optional(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
    });
    export type Create = z.infer<typeof Create>;

    export const Evaluation = z
      .object({
        workerRunId: z.string().min(1),
        action: z.string().min(1),
        sessionId: z.string().min(1).optional(),
        actorId: z.string().min(1).optional(),
        endpointId: z.string().min(1).optional(),
        createsExternalTask: z.boolean().optional(),
        actorGroup: z.string().min(1).optional(),
        risk: Risk.optional(),
      })
      .strict();
    export type Evaluation = z.infer<typeof Evaluation>;

    export const EvaluationResult = z
      .object({
        allowed: z.boolean(),
        reason: z.string().min(1),
        grantId: z.string().min(1).optional(),
      })
      .strict();
    export type EvaluationResult = z.infer<typeof EvaluationResult>;

    const EventBase = z.object({
      id: z.string().min(1),
      workerRunId: z.string().min(1),
      status: Status,
      version: z.number().int().min(1),
      time: z.number(),
    });

    export namespace Events {
      export const Created = BusEvent.define("worker_grant.created", EventBase);
      export const Updated = BusEvent.define("worker_grant.updated", EventBase);
      export const Revoked = BusEvent.define("worker_grant.revoked", EventBase);
      export const Expired = BusEvent.define("worker_grant.expired", EventBase);
      export const Evaluated = BusEvent.define(
        "worker_grant.evaluated",
        EventBase.extend({
          allowed: z.boolean(),
          reason: z.string().min(1),
          action: z.string().min(1),
        }),
      );
    }
  }
}
