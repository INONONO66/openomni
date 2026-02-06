import { randomUUID } from "crypto";
import { Bus, BusEvent } from "@openomni/session";
import { z } from "zod";

/**
 * Dead Letter Queue Entry interface
 * Represents an exhausted item that failed processing
 */
export interface DLQEntry {
  id: string;
  type: "event" | "run";
  payload: unknown;
  reason: string;
  timestamp: number;
  attempts: number;
}

/**
 * Dead Letter Queue namespace
 * Manages failed events and runs that have exhausted retry attempts
 */
export namespace DeadLetterQueue {
  // In-memory storage for DLQ entries
  const entries = new Map<string, DLQEntry>();

  // Define the audit event for DLQ writes
  const DLQWriteEvent = BusEvent.define(
    "dlq.write",
    z.object({
      id: z.string(),
      type: z.enum(["event", "run"]),
      reason: z.string(),
      timestamp: z.number(),
      attempts: z.number(),
    }),
  );

  /**
   * Adds an exhausted item to the Dead Letter Queue
   * @param entry - The DLQ entry without id and timestamp
   * @returns The complete DLQEntry with generated id and timestamp
   */
  export function add(entry: Omit<DLQEntry, "id" | "timestamp">): DLQEntry {
    const id = randomUUID();
    const timestamp = Date.now();

    const dlqEntry: DLQEntry = {
      ...entry,
      id,
      timestamp,
    };

    entries.set(id, dlqEntry);

    // Emit audit event
    Bus.publish(DLQWriteEvent, {
      id,
      type: entry.type,
      reason: entry.reason,
      timestamp,
      attempts: entry.attempts,
    });

    return dlqEntry;
  }

  /**
   * Returns all DLQ entries
   * @returns Array of all DLQEntry items
   */
  export function list(): DLQEntry[] {
    return Array.from(entries.values());
  }

  /**
   * Replays an item from the DLQ
   * Removes the item from the queue and returns true if found
   * @param id - The ID of the DLQ entry to replay
   * @returns true if the entry was found and removed, false otherwise
   */
  export function replay(id: string): boolean {
    return entries.delete(id);
  }

  /**
   * Clears all entries from the Dead Letter Queue
   */
  export function clear(): void {
    entries.clear();
  }
}
