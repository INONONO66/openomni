import type { SessionRunnerResult, SessionHandle } from "./session-contract";
import type { ExecutionApprovals } from "./executor";
import type { SessionError } from "./errors";
import type { Fiber } from "effect";
import type { createRawSlots } from "./executor-raw";
export interface SessionControllerState {
  active: Fiber.RuntimeFiber<SessionRunnerResult | undefined, SessionError> | undefined;
  controller: AbortController | undefined;
  fence: number;
  closed: boolean;
  terminalFrozen: boolean;
  released: boolean;
  successor: SessionHandle | undefined;
  heartbeat: Fiber.RuntimeFiber<void, SessionError> | undefined;
  retainedRunner: Fiber.RuntimeFiber<void, SessionError> | undefined;
  retainedFailure: SessionError | undefined;
  rawSlots: ReturnType<typeof createRawSlots>;
  activeApprovals: ExecutionApprovals | undefined;
}
