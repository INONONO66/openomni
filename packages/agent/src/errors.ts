import { Data } from "effect";
import type { AgentStopError } from "./core/execution/stop-chain";
import { ForeignFailure, type LedgerError } from "@openomni/ledger";
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

export class InvocationClosed extends Data.TaggedError("InvocationClosed")<{
  readonly tool: string;
  readonly reason: "settled" | "failed" | "interrupted";
}> {}

export class Interrupted extends Data.TaggedError("Interrupted")<Record<never, never>> {}

export class CommitFailed extends Data.TaggedError("CommitFailed")<{
  readonly error: LedgerError;
}> {
  override get message(): string {
    return this.error.message === "" ? this.error._tag : `${this.error._tag}: ${this.error.message}`;
  }
}

export class OutcomeUnknown extends Data.TaggedError("OutcomeUnknown")<{
  readonly reason: string;
}> {}

/** The one foreign-failure class: ledger owns it, the agent re-exports it. */
export { ForeignFailure };

/** Agent-owned failure for a Cause without a typed error; `Failure.of` synthesizes it. */
export class AgentFailure extends Data.TaggedError("AgentFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {
  override get message(): string { return `${this.operation}: ${this.cause}`; }
}

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

export class GenerationUnsettled extends Data.TaggedError("GenerationUnsettled")<{
  readonly sessionId: string;
  readonly generation: number;
  readonly owners: number;
}> {
  override get message(): string {
    return `session ${this.sessionId} generation ${this.generation} has ${this.owners} live owner(s)`;
  }
}

export class BundleError extends Data.TaggedError("BundleError")<{
  readonly code: "namespace" | "duplicate" | "requirement" | "metadata" | "missing_output" | "acquisition" | "policy" | "selection";
  readonly bundle: string;
  readonly detail: string;
}> {
  override get message(): string { return `${this.code}: ${this.bundle}: ${this.detail}`; }
}

export class ExecutionApprovalError extends Data.TaggedError("ExecutionApprovalError")<{
  readonly code: "stale_approval" | "approval_authority_unavailable" | "unauthenticated";
}> {}

export type ExecutionError =
  | LlmRunFailure
  | PolicyDenied
  | ToolBodyFailed
  | InvocationClosed
  | GenerationUnavailable
  | Interrupted
  | ContextAdmissionError
  | CommitFailed
  | OutcomeUnknown
  | ForeignFailure
  | ExecutionApprovalError
  | AgentStopError;

export type SessionError = ExecutionError | SessionMissing | LeaseLost | GenerationUnavailable | GenerationUnsettled | LedgerError | BundleError;
