import { z } from "zod";
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
