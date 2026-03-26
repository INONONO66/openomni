import { Bus, BusEvent } from "@openomni/session";
import { randomUUID } from "crypto";
import { z } from "zod";

/**
 * Event metadata containing correlation IDs and timing information
 */
export interface EventMetadata {
  traceId: string;
  runId: string;
  taskId: string;
  timestamp: number;
}

/**
 * Queue metrics tracking depth, wait times, and processing statistics
 */
export interface QueueMetrics {
  depth: number;
  waitTimeMs: number;
  processedCount: number;
}

/**
 * Run metrics tracking budget usage, duration, and turn count
 */
export interface RunMetrics {
  budgetUsage: number;
  durationMs: number;
  turnCount: number;
}

/**
 * Represents a single audit log entry
 */
export interface AuditEntry {
  id: string;
  type: "routing" | "permission" | "run";
  timestamp: number;
  runId: string;
  details: unknown;
}

/**
 * In-memory storage for metrics tracking
 */
const metricsStore = {
  queue: {
    depth: 0,
    waitTimeMs: 0,
    processedCount: 0,
  } as QueueMetrics,
  runs: new Map<string, RunMetrics>(),
};

/**
 * In-memory audit log storage
 */
const entries: AuditEntry[] = [];

/**
 * Run lifecycle event descriptor
 */
const RunLifecycleEvent = BusEvent.define(
  "run.lifecycle",
  z.object({
    runId: z.string(),
    event: z.string(),
    metrics: z.object({
      budgetUsage: z.number(),
      durationMs: z.number(),
      turnCount: z.number(),
    }),
    timestamp: z.number(),
  }),
);

/**
 * Observability namespace providing event enrichment and metrics tracking
 */
export namespace Observability {
  /**
   * Enriches an event with correlation IDs and metadata
   * @param event - The event to enrich
   * @param metadata - Correlation IDs and timing information
   * @returns Enriched event with metadata
   */
  export function enrichEvent(event: unknown, metadata: EventMetadata): unknown {
    if (typeof event !== "object" || event === null) {
      return {
        data: event,
        ...metadata,
      };
    }

    return {
      ...event,
      traceId: metadata.traceId,
      runId: metadata.runId,
      taskId: metadata.taskId,
      timestamp: metadata.timestamp,
    };
  }

  /**
   * Returns current queue metrics including depth and wait times
   * @returns Current queue metrics
   */
  export function getQueueMetrics(): QueueMetrics {
    return { ...metricsStore.queue };
  }

  /**
   * Returns budget usage and lifecycle metrics for a specific run
   * @param runId - The run identifier
   * @returns Run metrics or default values if run not found
   */
  export function getRunMetrics(runId: string): RunMetrics {
    const metrics = metricsStore.runs.get(runId);
    if (!metrics) {
      return {
        budgetUsage: 0,
        durationMs: 0,
        turnCount: 0,
      };
    }
    return { ...metrics };
  }

  /**
   * Emits a run lifecycle event with metrics
   * @param runId - The run identifier
   * @param event - The lifecycle event name
   * @param metrics - Run metrics to include
   */
  export function emitRunEvent(runId: string, event: string, metrics: RunMetrics): void {
    // Store metrics for later retrieval
    metricsStore.runs.set(runId, { ...metrics });

    // Emit event via Bus
    Bus.publish(RunLifecycleEvent, {
      runId,
      event,
      metrics: {
        budgetUsage: metrics.budgetUsage,
        durationMs: metrics.durationMs,
        turnCount: metrics.turnCount,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Updates queue metrics (internal use)
   * @param metrics - Updated queue metrics
   */
  export function updateQueueMetrics(metrics: Partial<QueueMetrics>): void {
    Object.assign(metricsStore.queue, metrics);
  }

  /**
   * Resets all metrics (useful for testing)
   */
  export function reset(): void {
    metricsStore.queue = {
      depth: 0,
      waitTimeMs: 0,
      processedCount: 0,
    };
    metricsStore.runs.clear();
    AuditLog.clear();
  }
}

/**
 * Audit log namespace with logging and retrieval functions
 */
export namespace AuditLog {
  /**
   * Logs a routing decision
   */
  export function logRouting(runId: string, decision: unknown): void {
    entries.push({
      id: randomUUID(),
      type: "routing",
      timestamp: Date.now(),
      runId,
      details: redactSensitive(decision),
    });
  }

  /**
   * Logs a permission decision
   */
  export function logPermission(runId: string, decision: unknown): void {
    entries.push({
      id: randomUUID(),
      type: "permission",
      timestamp: Date.now(),
      runId,
      details: redactSensitive(decision),
    });
  }

  /**
   * Logs a run outcome or summary
   */
  export function logRunOutcome(runId: string, outcome: unknown): void {
    entries.push({
      id: randomUUID(),
      type: "run",
      timestamp: Date.now(),
      runId,
      details: redactSensitive(outcome),
    });
  }

  /**
   * Retrieves all audit entries for a specific run
   */
  export function getEntries(runId: string): AuditEntry[] {
    return entries.filter((entry) => entry.runId === runId);
  }

  /**
   * Clears all audit log entries (useful for testing)
   */
  export function clear(): void {
    entries.length = 0;
  }

  /**
   * Redacts sensitive fields from data structures
   * Replaces values for fields like password, token, secret, key with '[REDACTED]'
   */
  export function redactSensitive(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data !== "object") {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => redactSensitive(item));
    }

    const redacted: Record<string, unknown> = {};
    const sensitiveFields = ["password", "token", "secret", "key"];

    for (const [key, value] of Object.entries(data)) {
      if (sensitiveFields.includes(key.toLowerCase())) {
        redacted[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null) {
        redacted[key] = redactSensitive(value);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }
}
