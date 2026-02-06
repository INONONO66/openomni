// Audit Log - P6-6
// Tracks routing decisions, permission checks, and run outcomes

import { randomUUID } from "crypto";

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
 * In-memory audit log storage
 */
const entries: AuditEntry[] = [];

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
