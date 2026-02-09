import type { EventEnvelope } from "../loop/envelope";
import type { Session } from "@openomni/session";
import type {
  NotificationRequest,
  NotificationResult,
} from "@openomni/protocol";

// ============================================================
// 1. InboundEvent — raw event from any surface (Slack, TUI, Telegram, Scheduler)
// ============================================================

export interface InboundEvent {
  /** Unique event identifier */
  id: string;
  /** Surface type: "tui" | "slack" | "telegram" | "scheduler" | etc. */
  surface: string;
  /** Channel or conversation identifier within the surface */
  channel?: string;
  /** Workspace/team identifier */
  workspace?: string;
  /** User who triggered the event (absent for automated triggers) */
  userId?: string;
  /** Event name (e.g., "message", "command", "cron_fire") */
  name: string;
  /** Raw payload from the surface */
  payload: unknown;
  /** Deduplication key — events with same key within window are dropped */
  dedupeKey?: string;
  /** ISO 8601 timestamp when the event occurred at the surface */
  occurredAt?: string;
  /** Additional surface-specific metadata */
  meta?: Record<string, unknown>;
  /** Lane classification: "control" (can create task runs) or "telemetry" (observability only) */
  lane?: "control" | "telemetry";
}

// ============================================================
// 2. RunRequest — execution plan produced by RunPlanner
// ============================================================

export type RunRequestKind = "run_agent" | "trigger_task" | "notify_only";

export interface RunRequest {
  /** Execution strategy */
  kind: RunRequestKind;
  /** Resolved session for the run */
  session: Session.Info;
  /** Normalized event envelope */
  envelope: EventEnvelope;
  /** Task ID to trigger (for trigger_task kind) */
  taskId?: string;
  /** Signal payload for TaskManager.trigger() */
  triggerSignal?: {
    triggerId: string;
    type: "cron" | "interval" | "once" | "event" | "manual";
    payload?: Record<string, unknown>;
    context?: {
      conversationSessionId?: string;
      userId?: string;
      workspaceId?: string;
      traceId?: string;
    };
    occurredAt: number;
  };
  /** Agent configuration for run_agent kind */
  agentConfig?: {
    agentType?: string;
    maxRetries?: number;
    sessionMode?: "ephemeral" | "persistent" | "reuse";
  };
  /** Notification request for notify_only kind */
  notificationRequest?: NotificationRequest;
}

// ============================================================
// 4. RunResult — execution outcome
// ============================================================

export interface RunResult {
  /** Whether the run succeeded */
  success: boolean;
  /** Summary of what happened */
  summary: string;
  /** Error message if failed */
  error?: string;
  /** Run ID if a task run was created */
  runId?: string;
  /** Session ID used for execution */
  sessionId: string;
  /** The request that produced this result */
  request: RunRequest;
}

// ============================================================
// 5. EventSourceAdapter — inbound event source (app-layer extension point)
// ============================================================

/**
 * @todo Implement in app layer (e.g., TUI adapter, webhook server, Slack listener).
 * This is an extension point for custom event sources.
 */
export interface EventSourceAdapter {
  /** Unique name for this adapter (e.g., "tui", "slack", "webhook") */
  name: string;
  /** Start listening for events and emit them via the callback */
  start(emit: (event: InboundEvent) => void): Promise<void>;
  /** Stop listening for events */
  stop(): Promise<void>;
}

// ============================================================
// 6. EventDecoder — raw payload → InboundEvent (app-layer extension point)
// ============================================================

/**
 * @todo Implement in app layer to decode surface-specific payloads.
 * This is an extension point for custom event decoding logic.
 */
export interface EventDecoder<TRaw = unknown> {
  /** Unique name for this decoder (e.g., "slack_decoder", "webhook_decoder") */
  name: string;
  /** Decode a raw payload into an InboundEvent, or return null if not applicable */
  decode(raw: TRaw): InboundEvent | null;
}

// ============================================================
// 7. DeliveryAdapter — response routing back to surface
// ============================================================

export interface DeliveryAdapter {
  /** Unique name for this adapter (e.g., "tui", "slack", "noop") */
  name: string;
  /** Deliver a run result back to the originating surface */
  deliver(result: RunResult): Promise<void>;
}

// ============================================================
// 8. NotificationAdapter — notification delivery (app-layer extension point)
// ============================================================

/**
 * @todo Implement in app layer (e.g., email, SMS, Slack notification, etc.).
 * This is an extension point for custom notification delivery.
 */
export interface NotificationAdapter {
  /** Unique name for this adapter (e.g., "email", "slack", "sms", "noop") */
  name: string;
  /** Send a notification and return delivery result */
  notify(request: NotificationRequest): Promise<NotificationResult>;
}

// ============================================================
// 6. RunPlanner — execution strategy selection
// ============================================================

export interface RunPlanner {
  /**
   * Given a normalized envelope and resolved session, produce RunRequest(s).
   * Most events produce a single RunRequest, but batch/fan-out is possible.
   */
  plan(envelope: EventEnvelope, session: Session.Info): RunRequest[];
}
