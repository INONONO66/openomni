import { Events as EventDescriptors } from "./events.js";
import * as Fold from "./fold.js";
import * as Schema from "./schema.js";

/**
 * Engagement — the durable delegation object (gateway-design §5, #709;
 * core-model Tier 2, Owner addition 2026-08-19). The FSM of authority and
 * resumption, never of dialogue content: terms are recorded verbatim, edges
 * are enforced mechanically, judgment stays in the LLM.
 */
export namespace Engagement {
  export const State = Schema.State;
  export type State = Schema.State;

  export const Terms = Schema.Terms;
  export type Terms = Schema.Terms;

  export const Record = Schema.Record;
  export type Record = Schema.Record;

  export const Create = Schema.Create;
  export type Create = Schema.Create;

  export const open = Schema.open;

  export const StoreErrorCode = Schema.StoreErrorCode;
  export type StoreErrorCode = Schema.StoreErrorCode;

  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export const TransitionInput = Fold.TransitionInput;
  export type TransitionInput = Fold.TransitionInput;

  export const RejectionCode = Fold.RejectionCode;
  export type RejectionCode = Fold.RejectionCode;

  export type Outcome = Fold.Outcome;

  export const transition = Fold.transition;
  export const expire = Fold.expire;
  export const isTerminal = Fold.isTerminal;

  export const Events = EventDescriptors;
}
