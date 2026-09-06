import type { SessionRunnerResult, SessionHandle } from "./session-contract";
import type { ExecutionApprovals } from "./executor";
export interface SessionControllerState {
  active: Promise<SessionRunnerResult | undefined> | undefined;
  controller: AbortController | undefined;
  fence: number;
  closed: boolean;
  released: boolean;
  successor: SessionHandle | undefined;
  stopHeartbeat: (() => void) | undefined;
  liveInterruptRunner: Promise<SessionRunnerResult> | undefined;
  retainedRunner: Promise<void> | undefined;
  retainedFailure: Error | undefined;
  activeApprovals: ExecutionApprovals | undefined;
}
