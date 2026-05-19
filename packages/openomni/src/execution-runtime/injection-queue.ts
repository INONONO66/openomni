export namespace InjectionQueue {
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
      const pending = pendingByRunId.get(runId);
      if (pending === undefined) {
        pendingByRunId.set(runId, [response]);
        return;
      }

      pending.push(response);
    }

    function drain(runId: string): PendingResponse[] {
      const pending = pendingByRunId.get(runId);
      if (pending === undefined) return [];

      pendingByRunId.delete(runId);
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
