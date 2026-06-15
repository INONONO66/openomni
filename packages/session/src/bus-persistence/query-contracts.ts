import { z } from "zod";

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
  data: z.record(z.string(), z.unknown()).describe("Event payload data"),
  traceId: z.string().describe("Trace ID for correlation"),
  durationMs: z.number().optional().describe("Duration in milliseconds if applicable"),
  timeCreated: z.number().describe("Timestamp when event was created (ms since epoch)"),
});
export type EventRecord = z.infer<typeof EventRecord>;

export const QueryOptions = z.object({
  type: z.string().optional().describe("Filter by event type"),
  category: z.string().optional().describe("Filter by category"),
  after: z.number().optional().describe("Only events after this timestamp (ms)"),
  before: z.number().optional().describe("Only events before this timestamp (ms)"),
  limit: z.number().int().positive().optional().describe("Maximum number of results"),
});
export type QueryOptions = z.infer<typeof QueryOptions>;

export const ChainIntegrityResult = z.object({
  valid: z.boolean().describe("Whether the entire chain is intact"),
  totalVerified: z.number().describe("Number of events verified"),
  brokenAtId: z.number().optional().describe("bus_event id where the chain first broke"),
  brokenAtEventType: z.string().optional().describe("Event type of the broken link"),
});
export type ChainIntegrityResult = z.infer<typeof ChainIntegrityResult>;

export const AuditChainRecord = z.object({
  seq: z.number(),
  sessionId: z.string().optional(),
  eventType: z.string(),
  eventHash: z.string(),
  prevHash: z.string(),
  timeCreated: z.number(),
});
export type AuditChainRecord = z.infer<typeof AuditChainRecord>;
