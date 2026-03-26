import { randomUUID } from "crypto";
import { Envelope, type EventEnvelope } from "../dispatch";
import { RunWorker } from "../worker";
import { SessionResolver } from "./session-resolver";
import { TaskManager } from "../task";
import type { Session } from "@openomni/session";
import type { NotificationRequest, NotificationResult } from "@openomni/protocol";
import { DefaultRunExecutor, type RunExecutor } from "./run-executor";

// ============================================================
// InboundEvent — raw event from any surface (Slack, TUI, Telegram, Scheduler)
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
// RunRequest — execution plan produced by RunPlanner
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
      originTaskId?: string;
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
// RunResult — execution outcome
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
// EventSourceAdapter — inbound event source (app-layer extension point)
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
// EventDecoder — raw payload → InboundEvent (app-layer extension point)
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
// DeliveryAdapter — response routing back to surface
// ============================================================

export interface DeliveryAdapter {
  /** Unique name for this adapter (e.g., "tui", "slack", "noop") */
  name: string;
  /** Deliver a run result back to the originating surface */
  deliver(result: RunResult): Promise<void>;
}

// ============================================================
// NotificationAdapter — notification delivery (app-layer extension point)
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
// RunPlanner — execution strategy selection
// ============================================================

export interface RunPlanner {
  /**
   * Given a normalized envelope and resolved session, produce RunRequest(s).
   * Most events produce a single RunRequest, but batch/fan-out is possible.
   */
  plan(envelope: EventEnvelope, session: Session.Info): RunRequest[];
}

// ============================================================
// Dedup Store (in-memory, TTL-based)
// ============================================================

interface DedupeEntry {
  key: string;
  timestamp: number;
  result: RunResult;
}

const dedupeStore = new Map<string, DedupeEntry>();
const DEFAULT_DEDUP_WINDOW_MS = 60_000;

function checkDedup(key: string, windowMs: number): RunResult | undefined {
  const entry = dedupeStore.get(key);
  if (!entry) return undefined;

  const now = Date.now();
  if (now - entry.timestamp > windowMs) {
    dedupeStore.delete(key);
    return undefined;
  }

  return entry.result;
}

function recordDedup(key: string, result: RunResult): void {
  dedupeStore.set(key, { key, timestamp: Date.now(), result });
}

// ============================================================
// Default RunPlanner
// ============================================================

import { classifyLane } from "./event-kinds";

export const DefaultRunPlanner: RunPlanner = {
  plan(envelope: EventEnvelope, session) {
    // Lane guard: telemetry events never create durable task runs
    if (classifyLane(envelope.name) === "telemetry") {
      return [];
    }

    const isCompletion =
      envelope.name === "subagent.completed" || envelope.name === "subagent.failed";

    if (isCompletion) {
      if (!envelope.meta?.taskId) {
        console.warn(`[IngressEngine] Completion event without taskId dropped: ${envelope.name}`);
        return [];
      }

      const targetTaskId = envelope.meta.taskId as string;
      const originTaskId = envelope.meta.originTaskId as string | undefined;

      if (originTaskId && originTaskId === targetTaskId) {
        console.warn(
          `[anti-loop] self-retrigger blocked: originTaskId=${originTaskId}, taskId=${targetTaskId}`,
        );
        return [];
      }

      return [
        {
          kind: "trigger_task",
          session,
          envelope,
          taskId: targetTaskId,
          triggerSignal: {
            triggerId: (envelope.meta.triggerId as string) ?? envelope.eventId,
            type: "event",
            payload:
              typeof envelope.payload === "object" && envelope.payload !== null
                ? (envelope.payload as Record<string, unknown>)
                : undefined,
            context: {
              conversationSessionId: session.id,
              userId: envelope.userId,
              workspaceId: envelope.workspaceId,
              traceId: envelope.traceId,
              originTaskId,
            },
            occurredAt: new Date(envelope.occurredAt).getTime(),
          },
        },
      ];
    }

    // D6: Block trigger_task from task execution context
    if (envelope.meta?.executionContext === "task") {
      console.warn(`[D6] trigger_task blocked: executionContext=task, event=${envelope.name}`);
      return [];
    }

    const isScheduled =
      envelope.source.type === "scheduler" ||
      envelope.source.type === "cron" ||
      envelope.source.type === "interval" ||
      envelope.source.type === "once";

    if (isScheduled && envelope.meta?.taskId) {
      const taskId = envelope.meta.taskId as string;
      return [
        {
          kind: "trigger_task",
          session,
          envelope,
          taskId,
          triggerSignal: {
            triggerId: (envelope.meta.triggerId as string) ?? envelope.eventId,
            type:
              (envelope.meta.triggerType as RunRequest["triggerSignal"] extends {
                type: infer T;
              }
                ? T
                : never) ?? "event",
            payload:
              typeof envelope.payload === "object" && envelope.payload !== null
                ? (envelope.payload as Record<string, unknown>)
                : undefined,
            context: {
              conversationSessionId: session.id,
              userId: envelope.userId,
              workspaceId: envelope.workspaceId,
              traceId: envelope.traceId,
            },
            occurredAt: new Date(envelope.occurredAt).getTime(),
          },
        },
      ];
    }

    return [
      {
        kind: "run_agent",
        session,
        envelope,
        agentConfig: {
          maxRetries: 1,
          sessionMode: "persistent" as const,
        },
      },
    ];
  },
};

// ============================================================
// Default DeliveryAdapter (noop — logs only)
// ============================================================

export const NoopDeliveryAdapter: DeliveryAdapter = {
  name: "noop",
  async deliver(_result: RunResult): Promise<void> {},
};

// ============================================================
// Default NotificationAdapter (noop — no-op)
// ============================================================

export const NoopNotificationAdapter: NotificationAdapter = {
  name: "noop",
  async notify() {
    return { delivered: true };
  },
};

// ============================================================
// IngressEngine
// ============================================================

export interface IngressEngineConfig {
  planner?: RunPlanner;
  delivery?: DeliveryAdapter;
  notification?: NotificationAdapter;
  executor?: RunExecutor;
  dedupeWindowMs?: number;
  defaultModel?: { providerID: string; modelID: string };
  llm?: {
    run(input: Record<string, unknown>, sink: any): Promise<any>;
  };
}

export namespace IngressEngine {
  let config: IngressEngineConfig = {};

  export function configure(overrides: IngressEngineConfig): void {
    config = { ...config, ...overrides };
  }

  export function reset(): void {
    config = {};
    dedupeStore.clear();
  }

  function toEventEnvelope(event: InboundEvent): EventEnvelope {
    const sourceId = [event.surface, event.workspace, event.channel].filter(Boolean).join(":");

    return Envelope.normalize({
      id: event.id,
      name: event.name,
      source: {
        type: event.surface,
        id: sourceId,
      },
      timestamp: event.occurredAt,
      payload: event.payload,
      dedupeKey: event.dedupeKey,
      userId: event.userId,
      workspaceId: event.workspace,
      metadata: event.meta,
    });
  }

  function validateInboundEvent(event: InboundEvent): void {
    if (!event.id || typeof event.id !== "string") {
      throw new Error("InboundEvent requires a non-empty string id");
    }
    if (!event.surface || typeof event.surface !== "string") {
      throw new Error("InboundEvent requires a non-empty string surface");
    }
    if (!event.name || typeof event.name !== "string") {
      throw new Error("InboundEvent requires a non-empty string name");
    }
  }

  function getExecutor(): RunExecutor {
    if (config.executor) {
      return config.executor;
    }
    return new DefaultRunExecutor({
      llm: config.llm,
      notification: config.notification,
    });
  }

  export async function ingest(event: InboundEvent): Promise<RunResult[]> {
    // 1. Validate
    validateInboundEvent(event);

    // 2. Convert to EventEnvelope
    const envelope = toEventEnvelope(event);

    // 3. Dedup check
    const dedupeWindowMs = config.dedupeWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    if (envelope.dedupeKey) {
      const cached = checkDedup(envelope.dedupeKey, dedupeWindowMs);
      if (cached) {
        return [cached];
      }
    }

    // 4. Resolve session
    const { session } = SessionResolver.resolve(envelope, config.defaultModel);

    // 5. Plan
    const planner = config.planner ?? DefaultRunPlanner;
    const requests = planner.plan(envelope, session);

    if (requests.length === 0) {
      return [];
    }

    // 6. Execute + 7. Deliver
    const delivery = config.delivery ?? NoopDeliveryAdapter;
    const executor = getExecutor();
    const results: RunResult[] = [];

    for (const request of requests) {
      const result = await executor.execute(request);
      results.push(result);

      if (envelope.dedupeKey) {
        recordDedup(envelope.dedupeKey, result);
      }

      await delivery.deliver(result);
    }

    return results;
  }
}
