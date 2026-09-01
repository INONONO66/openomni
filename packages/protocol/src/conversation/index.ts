import { ConversationEvents } from "./events.js";
import * as Fold from "./fold.js";
import * as Schema from "./schema.js";

export namespace Conversation {
  export const State = Schema.State;
  export type State = Schema.State;

  export const OpenedBy = Schema.OpenedBy;
  export type OpenedBy = Schema.OpenedBy;

  export const ClosedBy = Schema.ClosedBy;
  export type ClosedBy = Schema.ClosedBy;

  export const QuietHours = Schema.QuietHours;
  export type QuietHours = Schema.QuietHours;

  export const Policy = Schema.Policy;
  export type Policy = Schema.Policy;

  export const Record = Schema.Record;
  export type Record = Schema.Record;

  export const Create = Schema.Create;
  export type Create = Schema.Create;

  export const StoreErrorCode = Schema.StoreErrorCode;
  export type StoreErrorCode = Schema.StoreErrorCode;

  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export type CloseOutcome = Fold.CloseOutcome;
  export type OutboundRefusalReason = Fold.OutboundRefusalReason;
  export type OutboundOutcome = Fold.OutboundOutcome;
  export type InboundOutcome = Fold.InboundOutcome;

  export const open = Fold.open;
  export const close = Fold.close;
  export const admitOutbound = Fold.admitOutbound;
  export const recordInbound = Fold.recordInbound;

  export const Events = ConversationEvents;
}
