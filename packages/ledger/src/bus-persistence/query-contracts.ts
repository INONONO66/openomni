import { BusEvent } from "@openomni/protocol";
import { z } from "zod";

/** #499 L4: one visibility vocabulary — reuse the protocol enum, not a copy. */
export const EventVisibility = BusEvent.Visibility;
export type EventVisibility = BusEvent.Visibility;

const PayloadStatus = z.enum(["valid", "invalid", "parse_failed", "unmarked"]);

export const EventRecord = z.object({
  id: z.string().describe("Unique event record ID"),
  sessionId: z.string().describe("Session ID this event belongs to"),
  runId: z.string().optional().describe("Worker run ID if applicable"),
  eventType: z.string().describe("Event type name (e.g., 'agent.execution.started')"),
  category: z.string().describe("Event category"),
  visibility: EventVisibility.describe("Audience that should see this persisted event"),
  data: z.record(z.string(), z.unknown()).describe("Event payload data"),
  payloadStatus: PayloadStatus.describe("Schema status; unmarked identifies historical rows"),
  payloadDiagnostic: z.string().optional().describe("Safe payload parsing diagnostic"),
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
