import type { Execution } from "@openomni/protocol";

export interface CoordinatorLike {
  dispatch(sessionId: string, request: Execution.Request): Promise<Execution.Result>;
  cancelRun?(runId: string): Promise<unknown>;
  deliverMessage?(
    sessionId: string,
    message: string,
    traceId: string,
    runId?: string,
  ): Promise<unknown>;
}
