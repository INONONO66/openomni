import { z } from "zod";

export const EventVisibility = z.enum(["internal", "llm_reason", "user_audit", "ephemeral"]);
export type EventVisibility = z.infer<typeof EventVisibility>;

export const QueryStats = z.object({
  totalEvents: z.number().describe("Total number of events"),
  byCategory: z.record(z.number()).describe("Event count by category"),
  byType: z.record(z.number()).describe("Event count by type"),
});
export type QueryStats = z.infer<typeof QueryStats>;

export const EventRecord = z.object({
  id: z.string().describe("Unique event record ID"),
  sessionId: z.string().describe("Session ID this event belongs to"),
  runId: z.string().optional().describe("Worker run ID if applicable"),
  eventType: z.string().describe("Event type name (e.g., 'agent.execution.started')"),
  category: z.string().describe("Event category"),
  visibility: EventVisibility.describe("Audience that should see this persisted event"),
  data: z.record(z.string(), z.unknown()).describe("Event payload data"),
  traceId: z.string().describe("Trace ID for correlation"),
  durationMs: z.number().optional().describe("Duration in milliseconds if applicable"),
  timeCreated: z.number().describe("Timestamp when event was created (ms since epoch)"),
});
export type EventRecord = z.infer<typeof EventRecord>;

export const ChainIntegrityResult = z.object({
  valid: z.boolean().describe("Whether the entire chain is intact"),
  totalVerified: z.number().describe("Number of events verified"),
  brokenAtId: z.number().optional().describe("bus_event id where the chain first broke"),
  brokenAtEventType: z.string().optional().describe("Event type of the broken link"),
});
export type ChainIntegrityResult = z.infer<typeof ChainIntegrityResult>;
