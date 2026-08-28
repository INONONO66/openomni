// This file owns perimeter routing, pending communication, and active-egress storage contracts.
import type { Communication } from "../communication/index.js";
import type { Gateway } from "../gateway/index.js";

export type { Storage } from "./namespace.js";

declare module "./namespace.js" {
  namespace Storage {
    /**
     * Surface-key map rows (perimeter surface, #707): the N:1 surfaceKey →
     * sessionId claim table. `claim` is compare-and-swap shaped — with
     * `expectedSessionId` it replaces only while the current owner still equals
     * it, without it it inserts only when the key is absent — and always returns
     * the sessionId that owns the key after the attempt. The key format codec
     * stays `Channel.SurfaceKey`; this is the row surface only.
     */
    export interface SurfaceKeySubAdapter {
      claim(key: string, sessionId: string, expectedSessionId?: string): string;
      lookup(key: string): string | undefined;
      listBySession(sessionId: string): string[];
    }

    export interface PendingAskSubAdapter {
      create(record: Communication.PendingAsk.Record): void;
      get(id: string): Communication.PendingAsk.Record | undefined;
      list(status?: Communication.PendingAsk.Status[]): Communication.PendingAsk.Record[];
      findByCorrelation(
        query: Communication.PendingAsk.CorrelationQuery,
      ): Communication.PendingAsk.Record[];
      set(record: Communication.PendingAsk.Record): void;
      remove(id: string): boolean;
    }

    export interface PendingInteractionSubAdapter {
      create(record: Communication.PendingInteraction.Record): void;
      get(id: string): Communication.PendingInteraction.Record | undefined;
      list(
        status?: Communication.PendingInteraction.Status[],
      ): Communication.PendingInteraction.Record[];
      findByCorrelation(
        query: Communication.PendingInteraction.CorrelationQuery,
      ): Communication.PendingInteraction.Record[];
      set(record: Communication.PendingInteraction.Record): void;
      remove(id: string): boolean;
    }

    /**
     * Active-egress debit ledger (#219, perimeter domain): a per-(senderId,
     * targetActorId) append-only log of ADMITTED proactive sends. The gateway
     * router is the sole writer (same isolation as the wait store — the brain
     * never reaches it). `claim` atomically folds the projection, asks the
     * perimeter evaluator whether the row fits, and appends only when admitted.
     * Retrying the same row id is idempotently `claimed`.
     */
    export interface EgressBudgetSubAdapter {
      claim(
        row: Gateway.EgressDebitRow,
        windowStartAt: number,
        canClaim: (state: Gateway.EgressDebitState) => boolean,
      ): "claimed" | "refused";
    }
  }
}
