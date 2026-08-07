import { Events as EventDescriptors } from "./events.js";
import * as Fold from "./fold.js";
import * as Schema from "./schema.js";

export namespace Wait {
  export const OwnerKind = Schema.OwnerKind;
  export type OwnerKind = Schema.OwnerKind;

  export const OwnerRef = Schema.OwnerRef;
  export type OwnerRef = Schema.OwnerRef;

  export const Status = Schema.Status;
  export type Status = Schema.Status;

  export const AllowedAction = Schema.AllowedAction;
  export type AllowedAction = Schema.AllowedAction;

  export const Correlation = Schema.Correlation;
  export type Correlation = Schema.Correlation;

  export const ResolutionPolicy = Schema.ResolutionPolicy;
  export type ResolutionPolicy = Schema.ResolutionPolicy;

  export const Quorum = Schema.Quorum;
  export type Quorum = Schema.Quorum;

  export const Reply = Schema.Reply;
  export type Reply = Schema.Reply;

  export const Record = Schema.Record;
  export type Record = Schema.Record;

  export const Create = Schema.Create;
  export type Create = Schema.Create;

  export const CorrelationQuery = Schema.CorrelationQuery;
  export type CorrelationQuery = Schema.CorrelationQuery;

  export const StoreErrorCode = Schema.StoreErrorCode;
  export type StoreErrorCode = Schema.StoreErrorCode;

  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export const ReplyInput = Fold.ReplyInput;
  export type ReplyInput = Fold.ReplyInput;

  export const RejectionCode = Fold.RejectionCode;
  export type RejectionCode = Fold.RejectionCode;

  export type Outcome = Fold.Outcome;

  export const attachReply = Fold.attachReply;
  export const expire = Fold.expire;
  export const cancel = Fold.cancel;
  export const effectiveThreshold = Fold.effectiveThreshold;

  export const Events = EventDescriptors;
}
