import type { SessionRunnerResult, SessionHandle } from "./session-contract";
import type { ExecutionApprovals } from "./executor";
import type { SessionError } from "./errors";
import type { Fiber } from "effect";
import type { createRawSlots } from "./executor-raw";
export interface SessionControllerState {
  active: Fiber.Fiber<SessionRunnerResult | undefined, SessionError> | undefined;
  controller: AbortController | undefined;
  fence: number;
  closed: boolean;
  terminalFrozen: boolean;
  released: boolean;
  successor: SessionHandle | undefined;
  retainedRunner: Fiber.Fiber<void, SessionError> | undefined;
  retainedFailure: SessionError | undefined;
  rawSlots: ReturnType<typeof createRawSlots>;
  activeApprovals: ExecutionApprovals | undefined;
}
