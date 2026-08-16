import { z } from "zod";
import { BusEvent } from "../bus/index.js";

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
    canCreateExternalTasks: z.boolean(),
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
    traceId: z.string().min(1),
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
  traceId: z.string().min(1),
  workerRunId: z.string().min(1),
  status: Status,
  version: z.number().int().min(1),
  time: z.number(),
});

export const Events = {
  Created: BusEvent.define("worker_grant.created", EventBase, { visibility: "internal" }),
  Updated: BusEvent.define("worker_grant.updated", EventBase, { visibility: "internal" }),
  Revoked: BusEvent.define("worker_grant.revoked", EventBase, { visibility: "llm_reason" }),
  Expired: BusEvent.define("worker_grant.expired", EventBase, { visibility: "llm_reason" }),
  Evaluated: BusEvent.define(
    "worker_grant.evaluated",
    EventBase.extend({
      allowed: z.boolean(),
      reason: z.string().min(1),
      action: z.string().min(1),
    }),
    { visibility: "llm_reason" },
  ),
} as const;
