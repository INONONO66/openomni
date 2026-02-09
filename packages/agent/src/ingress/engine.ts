import { randomUUID } from "crypto";
import { normalize, Envelope, type EventEnvelope } from "../loop/envelope";
import { SessionResolver } from "./session-resolver";
import { TaskManager } from "../task/manager";
import { Orchestrator } from "../loop/orchestration";
import type {
  InboundEvent,
  RunRequest,
  RunResult,
  DeliveryAdapter,
  RunPlanner,
} from "./interfaces";

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

export const DefaultRunPlanner: RunPlanner = {
  plan(envelope: EventEnvelope, session) {
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
              (envelope.meta
                .triggerType as RunRequest["triggerSignal"] extends {
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
// IngressEngine
// ============================================================

export interface IngressEngineConfig {
  planner?: RunPlanner;
  delivery?: DeliveryAdapter;
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
    const sourceId = [event.surface, event.workspace, event.channel]
      .filter(Boolean)
      .join(":");

    return normalize({
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

  async function executeRunRequest(request: RunRequest): Promise<RunResult> {
    const sessionId = request.session.id;

    switch (request.kind) {
      case "trigger_task": {
        if (!request.taskId || !request.triggerSignal) {
          return {
            success: false,
            summary: "",
            error: "trigger_task requires taskId and triggerSignal",
            sessionId,
            request,
          };
        }

        const triggerResult = await TaskManager.trigger(
          request.taskId,
          request.triggerSignal,
        );

        if ("error" in triggerResult) {
          return {
            success: false,
            summary: "",
            error: `TaskManager.trigger failed: ${triggerResult.error}`,
            sessionId,
            request,
          };
        }

        return {
          success: true,
          summary: `Task ${request.taskId} triggered, runId: ${triggerResult.runId}`,
          runId: triggerResult.runId,
          sessionId,
          request,
        };
      }

      case "run_agent": {
        const taskId = randomUUID();
        const task = TaskManager.create({
          title: `Ingress run: ${request.envelope.name}`,
          owner: {
            type: request.envelope.userId ? "user" : "agent",
            id: request.envelope.userId ?? "system",
          },
          triggers: [{ id: randomUUID(), type: "manual" }],
        });

        const signal = {
          triggerId: task.triggers[0]!.id,
          type: "manual" as const,
          context: {
            conversationSessionId: sessionId,
            userId: request.envelope.userId,
            workspaceId: request.envelope.workspaceId,
            traceId: request.envelope.traceId,
          },
          occurredAt: Date.now(),
        };

        const triggerResult = await TaskManager.trigger(task.id, signal);
        if ("error" in triggerResult) {
          return {
            success: false,
            summary: "",
            error: `Failed to create run: ${triggerResult.error}`,
            sessionId,
            request,
          };
        }

        if (!config.llm) {
          return {
            success: true,
            summary: `Run scheduled: ${triggerResult.runId}`,
            runId: triggerResult.runId,
            sessionId,
            request,
          };
        }

        const orchResult = await Orchestrator.run(
          {
            taskId: task.id,
            runId: triggerResult.runId,
            maxRetries: request.agentConfig?.maxRetries ?? 1,
            sessionMode: request.agentConfig?.sessionMode ?? "persistent",
            sessionId,
          },
          {
            llm: config.llm,
            input: {
              prompt:
                typeof request.envelope.payload === "string"
                  ? request.envelope.payload
                  : JSON.stringify(request.envelope.payload),
            },
          },
        );

        return {
          success: orchResult.success,
          summary: orchResult.summary,
          error: orchResult.error || undefined,
          runId: triggerResult.runId,
          sessionId,
          request,
        };
      }

      case "notify_only": {
        return {
          success: true,
          summary: "Notification delivered",
          sessionId,
          request,
        };
      }

      default:
        return {
          success: false,
          summary: "",
          error: `Unknown run request kind: ${(request as RunRequest).kind}`,
          sessionId,
          request,
        };
    }
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
    const results: RunResult[] = [];

    for (const request of requests) {
      const result = await executeRunRequest(request);
      results.push(result);

      if (envelope.dedupeKey) {
        recordDedup(envelope.dedupeKey, result);
      }

      await delivery.deliver(result);
    }

    return results;
  }
}
