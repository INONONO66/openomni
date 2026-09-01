import { LeaseEvents } from "./events.js";
import * as Fold from "./fold.js";
import * as Schema from "./schema.js";

/**
 * Lease namespace (conversation-and-message-io.md §3.5): schemas, the pure
 * issue/close/debit folds, the lifecycle events, and the typed store error.
 * Durable persistence lives in `@openomni/ledger`'s LeaseStore.
 */
export namespace Lease {
  export const State = Schema.State;
  export type State = Schema.State;

  export const ClosedBy = Schema.ClosedBy;
  export type ClosedBy = Schema.ClosedBy;

  export const Budget = Schema.Budget;
  export type Budget = Schema.Budget;

  export const Record = Schema.Record;
  export type Record = Schema.Record;

  export const Create = Schema.Create;
  export type Create = Schema.Create;

  export const StoreErrorCode = Schema.StoreErrorCode;
  export type StoreErrorCode = Schema.StoreErrorCode;

  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export type CloseOutcome = Fold.CloseOutcome;
  export type DebitRefusalReason = Fold.DebitRefusalReason;
  export type DebitOutcome = Fold.DebitOutcome;

  export const issue = Fold.issue;
  export const close = Fold.close;
  export const debit = Fold.debit;

  export const Events = LeaseEvents;
}
