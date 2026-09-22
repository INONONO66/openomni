import { Data } from "effect";
import type { AgentStopError } from "./core/execution/stop-chain";
import type { LedgerError } from "@openomni/ledger";
import type { LlmRunFailure } from "@openomni/llm";

export { AgentStopError } from "./core/execution/stop-chain";

export class ContextAdmissionError extends Data.TaggedError("ContextAdmissionError")<Record<never, never>> {}

export class PolicyDenied extends Data.TaggedError("PolicyDenied")<{
  readonly phase: "pre" | "post";
  readonly ruleIds: readonly string[];
}> {}

export class ToolBodyFailed extends Data.TaggedError("ToolBodyFailed")<{
  readonly tool: string;
  readonly cause: string;
}> {}

export class Interrupted extends Data.TaggedError("Interrupted")<Record<never, never>> {}

export class CommitFailed extends Data.TaggedError("CommitFailed")<{
  readonly error: LedgerError;
}> {}

export class OutcomeUnknown extends Data.TaggedError("OutcomeUnknown")<{
  readonly reason: string;
}> {}

export class ForeignFailure extends Data.TaggedError("ForeignFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {}

export class SessionMissing extends Data.TaggedError("SessionMissing")<{
  readonly sessionId: string;
}> {}

export class LeaseLost extends Data.TaggedError("LeaseLost")<{
  readonly sessionId: string;
  readonly fence: number;
}> {}

export class GenerationUnavailable extends Data.TaggedError("GenerationUnavailable")<{
  readonly generation: number;
}> {}

export class ExecutionApprovalError extends Data.TaggedError("ExecutionApprovalError")<{
  readonly code: "stale_approval" | "approval_authority_unavailable" | "unauthenticated";
}> {}

export type ExecutionError =
  | LlmRunFailure
  | PolicyDenied
  | ToolBodyFailed
  | Interrupted
  | ContextAdmissionError
  | CommitFailed
  | OutcomeUnknown
  | ForeignFailure
  | ExecutionApprovalError
  | AgentStopError;

export type SessionError = ExecutionError | SessionMissing | LeaseLost | GenerationUnavailable | LedgerError;
