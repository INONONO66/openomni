import { Context, type Effect } from "effect";
import type {
  Alarm,
  Inbox,
  LedgerAction,
  LedgerSession,
  Storage as ProtocolStorage,
} from "@openomni/protocol";
import type { LedgerError } from "./errors";

export type CommitReceipt = Extract<LedgerSession.CommitResult, { readonly ok: true }>;
export type LeaseReceipt = Extract<LedgerSession.LeaseResult, { readonly ok: true }>;

export interface SessionWriteAdapter
  extends Pick<ProtocolStorage.SessionSubAdapter, "get" | "list" | "openChildCount"> {
  create(row: LedgerSession.Row): Effect.Effect<boolean, LedgerError>;
  materialize(
    input: LedgerSession.Materialize,
  ): Effect.Effect<LedgerSession.MaterializeResult, LedgerError>;
  acquireLease(input: LedgerSession.AcquireLease): Effect.Effect<LeaseReceipt, LedgerError>;
  renewLease(input: LedgerSession.RenewLease): Effect.Effect<true, LedgerError>;
  commit(input: LedgerSession.Commit): Effect.Effect<CommitReceipt, LedgerError>;
}

export interface InboxWriteAdapter extends Pick<ProtocolStorage.InboxSubAdapter, "list"> {
  commit(input: Inbox.Commit): Effect.Effect<Inbox.Row, LedgerError>;
  receive(
    input: Inbox.Commit,
  ): Effect.Effect<{ row: Inbox.Row; receipt: LedgerAction.Receipt }, LedgerError>;
}

export interface AlarmWriteAdapter extends Pick<ProtocolStorage.AlarmSubAdapter, "get" | "due"> {
  arm(input: Alarm.Arm): Effect.Effect<Alarm.Row, LedgerError>;
  cancel(id: string, sessionId: string, at: number): Effect.Effect<Alarm.Row, LedgerError>;
  rearm(id: string, sessionId: string, at: number): Effect.Effect<Alarm.Row, LedgerError>;
  acquire(id: string, expectedFence: number): Effect.Effect<Alarm.Row, LedgerError>;
  fire(input: Alarm.Fire): Effect.Effect<Alarm.Fired, LedgerError>;
}

export class LedgerWrites extends Context.Tag("@openomni/ledger/LedgerWrites")<
  LedgerWrites,
  {
    readonly sessions: SessionWriteAdapter;
    readonly inbox: InboxWriteAdapter;
    readonly alarms: AlarmWriteAdapter;
  }
>() {}
