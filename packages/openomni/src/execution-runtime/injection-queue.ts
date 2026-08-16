import { Bus, BusEvent } from "@openomni/session";
import { z } from "zod";

export namespace InjectionQueue {
  const Events = {
    ResponseQueued: BusEvent.define(
      "injection_queue.response.queued",
      z.object({
        runId: z.string(),
        traceId: z.string().min(1),
        messageId: z.string(),
        // `time`, not `timestamp`: the persistence reader keys occurrence
        // time off a `time` field and fell back to its own wall clock here.
        time: z.number(),
      }),
    ),
    ResponseDrained: BusEvent.define(
      "injection_queue.response.drained",
      z.object({
        runId: z.string(),
        traceId: z.string().min(1),
        count: z.number(),
        time: z.number(),
      }),
    ),
  };

  export interface PendingResponse {
    readonly messageId: string;
    readonly output: string;
    readonly injectToHistory?: boolean;
    readonly timestamp: number;
  }

  export interface Instance {
    enqueue(runId: string, response: PendingResponse, traceId: string): void;
    drain(runId: string, traceId: string): PendingResponse[];
    hasPending(runId: string): boolean;
    dispose(runId: string): void;
  }

  export function create(): Instance {
    const pendingByRunId = new Map<string, PendingResponse[]>();

    function enqueue(runId: string, response: PendingResponse, traceId: string): void {
      Bus.publish(Events.ResponseQueued, {
        runId,
        traceId,
        messageId: response.messageId,
        time: response.timestamp,
      });

      const pending = pendingByRunId.get(runId);
      if (pending === undefined) {
        pendingByRunId.set(runId, [response]);
        return;
      }

      pending.push(response);
    }

    function drain(runId: string, traceId: string): PendingResponse[] {
      const pending = pendingByRunId.get(runId);
      if (pending === undefined) {
        Bus.publish(Events.ResponseDrained, { runId, traceId, count: 0, time: Date.now() });
        return [];
      }

      pendingByRunId.delete(runId);
      Bus.publish(Events.ResponseDrained, {
        runId,
        traceId,
        count: pending.length,
        time: Date.now(),
      });
      return pending.slice();
    }

    function hasPending(runId: string): boolean {
      return (pendingByRunId.get(runId)?.length ?? 0) > 0;
    }

    function dispose(runId: string): void {
      pendingByRunId.delete(runId);
    }

    return { enqueue, drain, hasPending, dispose };
  }
}
