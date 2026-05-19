import { Bus, BusEvent } from "@openomni/session";
import { z } from "zod";

export namespace InjectionQueue {
  export const Events = {
    ResponseQueued: BusEvent.define(
      "injection_queue.response.queued",
      z.object({
        runId: z.string(),
        messageId: z.string(),
        timestamp: z.number(),
      }),
    ),
    ResponseDrained: BusEvent.define(
      "injection_queue.response.drained",
      z.object({
        runId: z.string(),
        count: z.number(),
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
    enqueue(runId: string, response: PendingResponse): void;
    drain(runId: string): PendingResponse[];
    hasPending(runId: string): boolean;
    dispose(runId: string): void;
  }

  export function create(): Instance {
    const pendingByRunId = new Map<string, PendingResponse[]>();

    function enqueue(runId: string, response: PendingResponse): void {
      Bus.publish(Events.ResponseQueued, {
        runId,
        messageId: response.messageId,
        timestamp: response.timestamp,
      });

      const pending = pendingByRunId.get(runId);
      if (pending === undefined) {
        pendingByRunId.set(runId, [response]);
        return;
      }

      pending.push(response);
    }

    function drain(runId: string): PendingResponse[] {
      const pending = pendingByRunId.get(runId);
      if (pending === undefined) {
        Bus.publish(Events.ResponseDrained, { runId, count: 0 });
        return [];
      }

      pendingByRunId.delete(runId);
      Bus.publish(Events.ResponseDrained, { runId, count: pending.length });
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
