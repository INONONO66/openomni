import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Policy } from "../policy/index.js";
import { Wait } from "../wait/index.js";
import { CommandSchemas } from "./schemas.js";

/**
 * #498 C3: the command seam reuses THE one correlation shape
 * (Wait.Correlation). A structured command correlation must carry its
 * endpoint+channel scope pins — enforced by this local type-narrowing refine
 * so no second correlation shape is exported.
 */
const ScopedCorrelation = Wait.Correlation.refine(
  (value): value is Wait.Correlation & { endpointId: string; channelId: string } =>
    value.endpointId !== undefined && value.channelId !== undefined,
  { message: "command correlation requires endpointId and channelId" },
);

export namespace Command {
  export const Target = CommandSchemas.Target;
  export type Target = CommandSchemas.Target;

  export const Input = z
    .object({
      action: z.string().min(1),
      target: Target,
      payload: z.unknown().optional(),
      wait: z.boolean().optional(),
      timeoutMs: z.number().int().min(0).optional(),
      correlation: z.union([z.string().min(1), ScopedCorrelation]).optional(),
      idempotencyKey: z.string().min(1).optional(),
    })
    .strict();
  export type Input = z.infer<typeof Input>;

  export const ActorContext = CommandSchemas.ActorContext;
  export type ActorContext = CommandSchemas.ActorContext;

  /** The submitted command request: the public Input plus runtime-minted identity. */
  export const Request = Input.extend({
    dispatchId: z.string().min(1),
    actor: ActorContext,
    traceId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    submittedAt: z.number(),
  }).strict();
  export type Request = z.infer<typeof Request>;

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
    traceId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    actor: ActorContext,
    action: z.string().min(1),
    target: Target,
    correlation: z.union([z.string().min(1), ScopedCorrelation]).optional(),
    time: z.number(),
  });

  export namespace Events {
    export const Submitted = BusEvent.define(
      "dispatch.submitted",
      EventBase.extend({
        payloadSummary: z.string().optional(),
        idempotencyKey: z.string().min(1).optional(),
      }),
      { visibility: "ephemeral" },
    );

    export const Authorized = BusEvent.define(
      "dispatch.authorized",
      EventBase.extend({
        verdict: z.literal("allow"),
        reason: z.string().optional(),
        policyId: z.string().optional(),
        effects: z.array(Policy.PolicyEffect).optional(),
      }),
      { visibility: "ephemeral" },
    );

    export const Denied = BusEvent.define(
      "dispatch.denied",
      EventBase.extend({
        verdict: z.enum(["deny", "pending"]),
        reason: z.string(),
        policyId: z.string().optional(),
        effects: z.array(Policy.PolicyEffect).optional(),
      }),
      { visibility: "llm_reason" },
    );

    export const Routed = BusEvent.define(
      "dispatch.routed",
      EventBase.extend({
        handler: z.string().min(1),
      }),
      { visibility: "ephemeral" },
    );

    export const Completed = BusEvent.define(
      "dispatch.completed",
      EventBase.extend({
        handler: z.string().min(1),
        durationMs: z.number().min(0),
        resultSummary: z.string().optional(),
      }),
      { visibility: "llm_reason" },
    );

    export const Failed = BusEvent.define(
      "dispatch.failed",
      EventBase.extend({
        handler: z.string().min(1).optional(),
        durationMs: z.number().min(0).optional(),
        reason: z.string(),
      }),
      { visibility: "llm_reason" },
    );
  }

  export const Actions = {
    ResidentAsk: "resident.ask",
    WorkerSpawn: "worker.spawn",
    WorkerComplete: "worker.complete",
    WorkerSend: "worker.send",
    WorkerResume: "worker.resume",
    WorkerCancel: "worker.cancel",
    ScheduleCreate: "schedule.create",
    ScheduleCancel: "schedule.cancel",
    ActorMessage: "actor.message",
    ActorReply: "actor.reply",
    ExternalAsk: "external.ask",
    A2aAsk: "a2a.ask",
    ApiAsk: "api.ask",
    DeviceCommand: "device.command",
  } as const;
}
