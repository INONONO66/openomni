import { Data } from "effect";

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly sessionId: string;
}> {}

export class MaterializeRefused extends Data.TaggedError("MaterializeRefused")<{
  readonly sessionId: string;
  readonly reason: "input" | "configuration" | "state";
}> {}

export class LeaseRefused extends Data.TaggedError("LeaseRefused")<{
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

export class InboxCommitRefused extends Data.TaggedError("InboxCommitRefused")<{
  readonly sessionId: string;
  readonly inboxId: string;
  readonly reason: "admission" | "identity" | "configuration";
}> {}

export class AlarmRefused extends Data.TaggedError("AlarmRefused")<{
  readonly alarmId: string;
  readonly operation: "arm" | "cancel" | "rearm" | "acquire" | "fire";
  readonly reason: "missing" | "session" | "state" | "fence" | "occurrence" | "append" | "prompt";
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
  readonly capability: "storage" | "sessions" | "actions" | "inbox" | "alarms" | "policies";
}> {}

export class CorruptRecord extends Data.TaggedError("CorruptRecord")<{
  readonly operation: string;
  readonly id: string;
}> {}

export class ForeignFailure extends Data.TaggedError("ForeignFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {}

export type LedgerError =
  | SessionNotFound
  | MaterializeRefused
  | LeaseRefused
  | CommitRefused
  | InboxCommitRefused
  | AlarmRefused
  | PolicyGenerationRefused
  | StorageUnavailable
  | CorruptRecord
  | ForeignFailure;
