import type { Execution } from "@openomni/protocol";

export interface CoordinatorLike {
  dispatch(sessionId: string, request: Execution.Request): Promise<Execution.Result>;
}
