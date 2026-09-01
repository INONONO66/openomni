import { ApprovalEvents } from "./events.js";
import * as Fold from "./fold.js";
import * as Schema from "./schema.js";

/**
 * Approval namespace (conversation-and-message-io.md §6): schemas, the pure
 * request/decide/decision folds, the lifecycle events, and the typed store
 * error. Durable persistence lives in `@openomni/ledger`'s ApprovalStore;
 * the acts an approval authorizes (contact promotion, endpoint merge) are
 * executed in the product app.
 */
export namespace Approval {
  export const State = Schema.State;
  export type State = Schema.State;

  export const DecidedBy = Schema.DecidedBy;
  export type DecidedBy = Schema.DecidedBy;

  export const Subject = Schema.Subject;
  export type Subject = Schema.Subject;

  export const Record = Schema.Record;
  export type Record = Schema.Record;

  export const Create = Schema.Create;
  export type Create = Schema.Create;

  export const StoreErrorCode = Schema.StoreErrorCode;
  export type StoreErrorCode = Schema.StoreErrorCode;

  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export type DecideOutcome = Fold.DecideOutcome;

  export const request = Fold.request;
  export const decide = Fold.decide;
  export const decision = Fold.decision;

  export const Events = ApprovalEvents;
}
