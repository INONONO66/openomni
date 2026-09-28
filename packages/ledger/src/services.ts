import { Context, type Effect } from "effect";
import type { LedgerSession, Storage as ProtocolStorage } from "@openomni/protocol";
import type { LedgerError } from "./errors";
import type { CatalogStore } from "./storage/catalog-store.js";
import type { SessionStore } from "./storage/session-store.js";

export type CommitReceipt = Extract<LedgerSession.CommitResult, { readonly ok: true }>;
export type AdoptReceipt = { readonly ok: true; readonly fence: number };

export interface SessionWriteAdapter
  extends Pick<ProtocolStorage.SessionSubAdapter, "get" | "list"> {
  create(row: LedgerSession.Row): Effect.Effect<boolean, LedgerError>;
  materialize(
    input: LedgerSession.Materialize,
  ): Effect.Effect<LedgerSession.MaterializeResult, LedgerError>;
  adoptFence(input: LedgerSession.AdoptFence): Effect.Effect<AdoptReceipt, LedgerError>;
  commit(input: LedgerSession.Commit): Effect.Effect<CommitReceipt, LedgerError>;
}

/**
 * The handle plane one process composes over (W5.2 F1): the shared catalog
 * store plus an opener for per-session ledger files. Entity activations own
 * the lifecycle of the stores they open.
 */
export interface LedgerHandles {
  readonly catalog: CatalogStore;
  readonly openSession: (sessionId: string) => SessionStore;
}

export class LedgerWrites extends Context.Service<LedgerWrites, LedgerHandles>()(
  "@openomni/ledger/LedgerWrites",
) {}
