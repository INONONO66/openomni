/**
 * Event Kind Constants and Lane Classification
 *
 * Defines the canonical event kinds and their classification into lanes:
 * - Control lane: events that can create durable task runs
 * - Telemetry lane: observability-only events that never create task runs
 */

// ============================================================
// EventKind Constants
// ============================================================

/**
 * Control lane event kinds (can create durable task runs)
 */
export const CONTROL_EVENT_KINDS = {
  /** User message from Slack, Telegram, TUI, or command */
  INPUT_MESSAGE: "input.message",
  /** External webhook payload */
  INPUT_WEBHOOK: "input.webhook",
  /** Scheduled trigger fire (cron, interval, once) */
  SCHEDULE_FIRE: "schedule.fire",
  /** Subagent spawned */
  SUBAGENT_SPAWNED: "subagent.spawned",
  /** Subagent completed successfully */
  SUBAGENT_COMPLETED: "subagent.completed",
  /** Subagent failed with error */
  SUBAGENT_FAILED: "subagent.failed",
} as const;

/**
 * Telemetry lane event kinds (observability only, never create task runs)
 */
export const TELEMETRY_EVENT_KINDS = {
  /** Runtime metrics */
  RUN_METRIC: "run.metric",
  /** Tool usage metrics */
  TOOL_METRIC: "tool.metric",
  /** Health check / heartbeat */
  HEARTBEAT: "heartbeat",
} as const;

/**
 * All event kinds combined
 */
export const EVENT_KINDS = {
  ...CONTROL_EVENT_KINDS,
  ...TELEMETRY_EVENT_KINDS,
} as const;

/**
 * EventKind type — union of all valid event kind strings
 */
export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];

// ============================================================
// Lane Classification
// ============================================================

/**
 * EventLane — classification of event into control or telemetry
 */
export type EventLane = "control" | "telemetry";

/**
 * Classify an event kind into its lane
 *
 * @param kind - Event kind string
 * @returns "control" or "telemetry" (unknown kinds default to "telemetry" as safe default)
 */
export function classifyLane(kind: string): EventLane {
  const controlKinds = Object.values(CONTROL_EVENT_KINDS);
  return (controlKinds as string[]).includes(kind) ? "control" : "telemetry";
}

/**
 * Check if an event kind is task-backable (can create durable task runs)
 *
 * Only allowlisted control kinds are task-backable.
 *
 * @param kind - Event kind string
 * @returns true if the kind can create a task run, false otherwise
 */
export function isTaskBackable(kind: string): boolean {
  const taskBackableKinds = Object.values(CONTROL_EVENT_KINDS);
  return (taskBackableKinds as string[]).includes(kind);
}
