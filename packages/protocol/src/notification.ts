import { z } from "zod";

// ============================================================
// Notification Severity
// ============================================================

export const NotificationSeverity = z.enum(["info", "warning", "error"]);
export type NotificationSeverity = z.infer<typeof NotificationSeverity>;

// ============================================================
// Delivery Mode
// ============================================================

export const DeliveryMode = z.enum([
  "reply_current_session",
  "dm",
  "new_session",
  "new_thread",
]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

// ============================================================
// Notification Request
// ============================================================

export const NotificationRequest = z.object({
  type: z.string(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  traceId: z.string().optional(),
  severity: NotificationSeverity,
  title: z.string(),
  body: z.string(),
  artifactRefs: z.array(z.string()).optional(),
  conversationSessionId: z.string().optional(),
  deliveryHint: DeliveryMode.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type NotificationRequest = z.infer<typeof NotificationRequest>;

// ============================================================
// Notification Result
// ============================================================

export const NotificationResult = z.object({
  delivered: z.boolean(),
  destination: z.string().optional(),
  externalMessageId: z.string().optional(),
  error: z.string().optional(),
});
export type NotificationResult = z.infer<typeof NotificationResult>;
