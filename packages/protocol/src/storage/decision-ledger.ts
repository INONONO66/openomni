// This file owns the atomic decision-ledger persistence contract.
import type { Ledger } from "../ledger/index.js";

export type { Storage } from "./namespace.js";

declare module "./namespace.js" {
  namespace Storage {
    /**
     * Decision-class ledger append on the storage-owned connection (#510
     * phase B). Exposed as a sub-adapter so a decision-class store can bind
     * `Ledger.append(event, expectedHead)` and its projection write into ONE
     * `Adapter.transaction` fsync unit — no record, no action. `cas_conflict`
     * guarantees nothing was written; retrying from the reported head is the
     * caller's decision.
     */
    export interface LedgerSubAdapter {
      append(event: Ledger.Input, expectedHead: Ledger.ExpectedHead): Ledger.Outcome;
      /**
       * Adopts a PRE-CUTOVER stream (#510 review fix F3): inserts the genesis
       * fact at seq === `headRevision` and sets the stream head to
       * `headRevision`, in one unit, ONLY while the stream is empty — a
       * non-empty stream throws the typed `Ledger.AdoptError`. Used by
       * revision-bound stores whose projection row predates its owner stream
       * (row revision >= 1, empty stream) so the head↔revision equation holds
       * without fabricating per-transition history.
       */
      adoptStream(streamId: string, headRevision: number, genesis: Ledger.AdoptGenesis): void;
      /**
       * Newest recorded fact of one stream (undefined for an empty stream) —
       * the #510 C3 replay read: on a single-fact stream append conflict the
       * caller re-executes from the recorded decision instead of re-deciding.
       */
      headFact(streamId: string): Ledger.RecordedFact | undefined;
      /**
       * Every recorded fact of one type across all streams, ordered by
       * (streamId, seq) — the #510 D3 read-only admin inspection surface
       * (`/admin/ledger/*`). Never a decision input: decision replay reads go
       * through {@link headFact} on the owner stream.
       */
      factsByType(type: string): Ledger.RecordedFact[];
      /**
       * Boot chain tail verification (#510 D1): walks the newest events of
       * every stream and RETURNS chain-break facts — it never throws on a
       * broken chain and never refuses boot. Recording the breaks (Operational
       * event, Governor incident later) is the boot caller's job. Full-chain
       * verification stays the #226 offline restore drill.
       */
      verifyTail(): Ledger.ChainBreak[];
    }
  }
}
