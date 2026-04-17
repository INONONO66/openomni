import { z } from "zod";

export namespace Notification {
  export const Severity = z.enum(["info", "warning", "error"]);
  export type Severity = z.infer<typeof Severity>;

  export const DeliveryMode = z.enum(["reply_current_session", "dm", "new_session", "new_thread"]);
  export type DeliveryMode = z.infer<typeof DeliveryMode>;

  export const Request = z.object({
    type: z.string(),
    taskId: z.string().optional(),
    runId: z.string().optional(),
    traceId: z.string().optional(),
    severity: Severity,
    title: z.string(),
    body: z.string(),
    artifactRefs: z.array(z.string()).optional(),
    conversationSessionId: z.string().optional(),
    deliveryHint: DeliveryMode.optional(),
    metadata: z.record(z.unknown()).optional(),
  });
  export type Request = z.infer<typeof Request>;

  export const Result = z.object({
    delivered: z.boolean(),
    destination: z.string().optional(),
    externalMessageId: z.string().optional(),
    error: z.string().optional(),
  });
  export type Result = z.infer<typeof Result>;
}
