import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const BaseEvent = z.object({
  traceId: z.string(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  time: z.number(),
});

const Target = z.object({
  kind: z.enum(["resident", "worker"]),
  sessionId: z.string().optional(),
  agentName: z.string().optional(),
  parentSessionId: z.string().optional(),
});

const InputSchema = z
  .object({
    target: Target,
    action: z.enum(["spawn", "send", "cancel", "resume", "schedule"]).optional(),
    payload: z.string(),
    wait: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(30000),
    injectToHistory: z.boolean().default(false),
    schedule: z.string().optional(),
    depth: z.number().int().min(0).default(0),
  })
  .superRefine((value, context) => {
    if (value.action === "schedule" && value.schedule === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule"],
        message: "schedule is required when action is schedule",
      });
    }

    if (value.action !== "schedule" && value.schedule !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule"],
        message: "schedule is only valid when action is schedule",
      });
    }
  });

const ResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("sent"),
    messageId: z.string().optional(),
  }),
  z.object({
    status: z.literal("delivered"),
    messageId: z.string().optional(),
    output: z.string().optional(),
  }),
  z.object({
    status: z.literal("scheduled"),
    messageId: z.string().optional(),
    jobId: z.string().optional(),
  }),
  z.object({
    status: z.literal("error"),
    messageId: z.string().optional(),
    error: z.string().optional(),
    timedOut: z.boolean().optional(),
  }),
]);

export namespace InboundMessage {
  export const TargetSchema = Target;
  export type Target = z.infer<typeof TargetSchema>;

  export const Input = InputSchema;
  export type Input = z.infer<typeof Input>;

  export const Result = ResultSchema;
  export type Result = z.infer<typeof Result>;

  export namespace Events {
    export const Sent = BusEvent.define(
      "inbound.message.sent",
      BaseEvent.extend({
        payload: z.object({
          messageId: z.string(),
          target: TargetSchema,
          action: z.enum(["spawn", "send", "cancel", "resume", "schedule"]).optional(),
        }),
      }),
    );

    export const Delivered = BusEvent.define(
      "inbound.message.delivered",
      BaseEvent.extend({
        payload: z.object({
          messageId: z.string(),
          output: z.string().optional(),
        }),
      }),
    );

    export const TimedOut = BusEvent.define(
      "inbound.message.timed_out",
      BaseEvent.extend({
        payload: z.object({
          messageId: z.string(),
        }),
      }),
    );
  }
}
