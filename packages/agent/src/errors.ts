import { Data } from "effect";
import type { AgentStopError } from "./core/execution/stop-chain";
import type { LedgerError } from "./store";
import type { LlmFailure, LlmRunFailure } from "./model";
import type { LedgerSession } from "@openomni/protocol";

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

/** Agent-owned failure for a Cause without a typed error; `Failure.of` synthesizes it. */
export class AgentFailure extends Data.TaggedError("AgentFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {
  override get message(): string { return `${this.operation}: ${this.cause}`; }
}

/** A context-restore the admission plane refused: the caller-selected compaction target is unknown or was never executed. */
export class ContextRestoreError extends Data.TaggedError("ContextRestoreError")<{
  readonly reason: "unknown_compaction" | "not_executed";
}> {
  override get message(): string { return `context restore refused: ${this.reason}`; }
}

/** A compaction execution the admission plane refused or whose recorded output no longer matches. */
export class CompactionExecutionError extends Data.TaggedError("CompactionExecutionError")<{
  readonly reason: string;
}> {
  override get message(): string { return `compaction execution refused: ${this.reason}`; }
}

/** A session commit the ledger refused; carries the full refusal verdict. */
export class SessionCommitError extends Data.TaggedError("SessionCommitError")<{
  readonly result: Exclude<LedgerSession.CommitResult, { readonly ok: true }>;
}> {
  override get message(): string { return `session commit ${this.result.reason}`; }
}

/** Named carrier for programmer-invariant violations thrown from non-Effect code paths. */
export class AgentInvariantViolation extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AgentInvariantViolation";
  }
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

/**
 * Perimeter mail whose provenance the turn could not authenticate: the turn
 * runs with `evidence_only` authority and this fact is recorded as a
 * violation observation (issue #1245). A recorded fact, never a failure-channel
 * value: tagged like `SessionPolicyRefusal`, not an `Error`.
 */
export class InboundAuthorityViolation {
  readonly _tag = "InboundAuthorityViolation";
  constructor(readonly reason: "unknown_origin" | "undeclared_treatment") {}
  get message(): string { return `inbound authority violation: ${this.reason}`; }
}

/** A turn whose executor sealed without any runner-produced output: a distinct typed result cause, not a policy refusal. */
export class RunnerOutputMissing {
  readonly _tag = "RunnerOutputMissing";
  constructor(readonly turnId: string) {}
  get message(): string { return `runner output missing: turn ${this.turnId}`; }
}

/**
 * A backlog admission the session entity refused: the durable views are
 * mutually inconsistent (e.g. a running session with no open turn). Recorded
 * as a typed refusal fact; drains report it instead of folding into a stop.
 */
export class SessionAdmissionRefused {
  readonly _tag = "SessionAdmissionRefused";
  constructor(readonly sessionId: string) {}
  get message(): string { return `session admission refused: ${this.sessionId}`; }
}

export type ExecutionError =
  | LlmRunFailure
  | LlmFailure
  | PolicyDenied
  | ToolBodyFailed
  | InvocationClosed
  | GenerationUnavailable
  | Interrupted
  | ContextAdmissionError
  | CommitFailed
  | OutcomeUnknown
  | AgentFailure
  | CompactionExecutionError
  | ExecutionApprovalError
  | AgentStopError;

export type SessionError = ExecutionError | SessionMissing | LeaseLost | GenerationUnavailable | GenerationUnsettled | LedgerError | BundleError | ContextRestoreError;
