import { z } from "zod";
import { Actor } from "../actor/index.js";
import { BusEvent } from "../bus/index.js";
import { Policy } from "../policy/index.js";
import { WorkItem } from "../work-item/index.js";

export namespace Dispatch {
  export const ActorKind = z.enum(["worker", "resident", "system", "user", "unknown"]);
  export type ActorKind = z.infer<typeof ActorKind>;

  export const TargetKind = z.enum([
    "worker",
    "resident",
    "external_actor",
    "schedule",
    "session",
    "surface",
    "system",
  ]);
  export type TargetKind = z.infer<typeof TargetKind>;

  export const Target = z
    .object({
      kind: TargetKind,
      id: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      parentSessionId: z.string().min(1).optional(),
      runId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      labels: z.array(z.string()).optional(),
      executorKind: WorkItem.ExecutorKind.optional(),
    })
    .strict()
    .superRefine((target, ctx) => {
      if (target.executorKind !== undefined && target.kind !== "worker") {
        ctx.addIssue({
          code: "custom",
          message: "executorKind is only supported for worker targets",
          path: ["executorKind"],
        });
      }
    });
  export type Target = z.infer<typeof Target>;

  export const Correlation = z
    .object({
      endpointId: z.string().min(1),
      channelId: z.string().min(1),
      replyToMessageId: z.string().min(1).optional(),
      threadId: z.string().min(1).optional(),
      tokenHash: z.string().min(1).optional(),
      externalConversationId: z.string().min(1).optional(),
    })
    .strict();
  export type Correlation = z.infer<typeof Correlation>;

  export const Input = z
    .object({
      action: z.string().min(1),
      target: Target,
      payload: z.unknown().optional(),
      wait: z.boolean().optional(),
      timeoutMs: z.number().int().min(0).optional(),
      correlation: z.union([z.string().min(1), Correlation]).optional(),
      idempotencyKey: z.string().min(1).optional(),
    })
    .strict();
  export type Input = z.infer<typeof Input>;

  export const ActorContext = z
    .object({
      kind: ActorKind,
      actorId: z.string().min(1),
      agentName: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      runId: z.string().min(1).optional(),
      workerRunId: z.string().min(1).optional(),
      workspaceRoot: z.string().min(1).optional(),
      permissions: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      trustTier: Actor.TrustTier.optional(),
      reason: z.string().min(1).optional(),
    })
    .strict();
  export type ActorContext = z.infer<typeof ActorContext>;

  export const Command = Input.extend({
    dispatchId: z.string().min(1),
    actor: ActorContext,
    traceId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    submittedAt: z.number(),
  }).strict();
  export type Command = z.infer<typeof Command>;

  export const Result = z
    .object({
      dispatchId: z.string().min(1),
      status: z.enum(["completed", "denied", "failed"]),
      output: z.unknown().optional(),
      error: z.string().optional(),
      reason: z.string().optional(),
      handler: z.string().optional(),
      durationMs: z.number().min(0).optional(),
    })
    .strict();
  export type Result = z.infer<typeof Result>;

  const EventBase = z.object({
    dispatchId: z.string().min(1),
    traceId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    actor: ActorContext,
    action: z.string().min(1),
    target: Target,
    correlation: z.union([z.string().min(1), Correlation]).optional(),
    time: z.number(),
  });

  export namespace Events {
    export const Submitted = BusEvent.define(
      "dispatch.submitted",
      EventBase.extend({
        payloadSummary: z.string().optional(),
        idempotencyKey: z.string().min(1).optional(),
      }),
    );

    export const Authorized = BusEvent.define(
      "dispatch.authorized",
      EventBase.extend({
        verdict: z.literal("allow"),
        reason: z.string().optional(),
        policyId: z.string().optional(),
        effects: z.array(Policy.PolicyEffect).optional(),
      }),
    );

    export const Denied = BusEvent.define(
      "dispatch.denied",
      EventBase.extend({
        verdict: z.enum(["deny", "pending"]),
        reason: z.string(),
        policyId: z.string().optional(),
        effects: z.array(Policy.PolicyEffect).optional(),
      }),
    );

    export const Routed = BusEvent.define(
      "dispatch.routed",
      EventBase.extend({
        handler: z.string().min(1),
      }),
    );

    export const Completed = BusEvent.define(
      "dispatch.completed",
      EventBase.extend({
        handler: z.string().min(1),
        durationMs: z.number().min(0),
        resultSummary: z.string().optional(),
      }),
    );

    export const Failed = BusEvent.define(
      "dispatch.failed",
      EventBase.extend({
        handler: z.string().min(1).optional(),
        durationMs: z.number().min(0).optional(),
        reason: z.string(),
      }),
    );
  }

  export const Actions = {
    ResidentAsk: "resident.ask",
    WorkerSpawn: "worker.spawn",
    WorkerSend: "worker.send",
    WorkerResume: "worker.resume",
    WorkerCancel: "worker.cancel",
    ScheduleCreate: "schedule.create",
    ScheduleCancel: "schedule.cancel",
    ActorMessage: "actor.message",
    ActorReply: "actor.reply",
  } as const;
}
