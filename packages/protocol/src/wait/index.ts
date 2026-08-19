import { Events as EventDescriptors } from "./events.js";
import * as Fold from "./fold.js";
import * as Matcher from "./matcher.js";
import * as RequestedAction from "./requested-action.js";
import * as Schema from "./schema.js";
import * as Upcast from "./upcast.js";

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

  export const DeliveryReceiptInput = Fold.DeliveryReceiptInput;
  export type DeliveryReceiptInput = Fold.DeliveryReceiptInput;

  export const RejectionCode = Fold.RejectionCode;
  export type RejectionCode = Fold.RejectionCode;

  export type Outcome = Fold.Outcome;

  export const attachReply = Fold.attachReply;
  export const recordDeliveryReceipt = Fold.recordDeliveryReceipt;
  export const expire = Fold.expire;
  export const cancel = Fold.cancel;
  export const effectiveThreshold = Fold.effectiveThreshold;

  // #707 slice 1 hoists — pure wait-domain folds formerly kernel-side.
  // The one inbound-action parser shared by ingress and dispatch (#548).
  export const requestedWaitAction = RequestedAction.requestedWaitAction;
  export type RequestedWaitAction = RequestedAction.RequestedWaitAction;

  // Read-only Wait views over frozen legacy pending-* rows (#215 upcast).
  export const waitViewOfPendingInteraction = Upcast.waitViewOfPendingInteraction;
  export const waitViewOfPendingAsk = Upcast.waitViewOfPendingAsk;

  // THE sender matcher core (#215): pure matching over protocol types; the
  // delivery-endpoint ActorRegistry resolution stays a caller-side effect
  // and reaches targetsOfWait as an input.
  export type ResponderTarget = Matcher.ResponderTarget;
  export type SenderEvidence = Matcher.SenderEvidence;
  export const responderCandidates = Matcher.responderCandidates;
  export const ingressEvidence = Matcher.ingressEvidence;
  export const dispatchEvidence = Matcher.dispatchEvidence;
  export const targetsOfPendingInteraction = Matcher.targetsOfPendingInteraction;
  export const targetsOfWait = Matcher.targetsOfWait;

  export const Events = EventDescriptors;
}
