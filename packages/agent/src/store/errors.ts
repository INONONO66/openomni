import { Data } from "effect";
import { AgentFailure } from "../kernel/failure";

export { AgentFailure };

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly sessionId: string;
}> {
  override get message(): string {
    return `session not found: ${this.sessionId}`;
  }
}

export class MaterializeRefused extends Data.TaggedError("MaterializeRefused")<{
  readonly sessionId: string;
  readonly reason: "input" | "configuration" | "state";
}> {}

export class FenceRefused extends Data.TaggedError("FenceRefused")<{
  readonly sessionId: string;
  readonly reason: "held" | "stale";
  readonly holder: string | null;
  readonly fence: number;
  readonly expiresAt: number | null;
}> {}

export class CommitRefused extends Data.TaggedError("CommitRefused")<{
  readonly sessionId: string;
  readonly reason: "revision" | "fence" | "inbox";
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly fence: number;
  readonly currentFence: number;
}> {}

export class PolicyGenerationRefused extends Data.TaggedError("PolicyGenerationRefused")<{
  readonly generation: number;
  readonly reason: "empty" | "conflict";
  readonly ruleName?: string;
}> {
  override get message(): string {
    return this.reason === "empty"
      ? "policy generation must not be empty"
      : `could not append policy row: ${this.ruleName}`;
  }
}

export class StorageUnavailable extends Data.TaggedError("StorageUnavailable")<{
  readonly capability: "storage" | "sessions" | "actions" | "policies";
}> {
  override get message(): string {
    return `L0 storage capability is unavailable: ${this.capability}`;
  }
}

export class CorruptRecord extends Data.TaggedError("CorruptRecord")<{
  readonly operation: string;
  readonly id: string;
}> {}

/**
 * A broken programmer invariant on a synchronous ledger path — corrupt or
 * missing stored facts, a capability gap, or caller misuse. Thrown, never
 * `Effect.fail`ed: these paths are not Effect code and the condition is not a
 * caller-handleable refusal.
 */
export class LedgerInvariant extends Data.TaggedError("LedgerInvariant")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: Error;
}> {}

/** An incoherent reply-grant projection row observed by the SQLite adapter. */
export class ReplyGrantProjectionError extends Error {
  readonly code = "incoherent_reply_grant";

  constructor(readonly grantId: string) {
    super(`Incoherent reply-grant projection: ${grantId}`);
    this.name = "ReplyGrantProjectionError";
  }
}

export type LedgerError =
  | SessionNotFound
  | MaterializeRefused
  | FenceRefused
  | CommitRefused
  | PolicyGenerationRefused
  | StorageUnavailable
  | CorruptRecord
  | AgentFailure;
