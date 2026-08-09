import { Envelope as EnvelopeSchema } from "./envelope.js";
import * as PendingAskSchema from "./pending-ask.js";
import * as PendingInteractionSchema from "./pending-interaction.js";
import * as WorkerGrantSchema from "./worker-grant.js";

export namespace Communication {
  export const Envelope = EnvelopeSchema;
  export type Envelope = EnvelopeSchema;

  export namespace PendingAsk {
    export const Status = PendingAskSchema.Status;
    export type Status = PendingAskSchema.Status;

    export const TargetKind = PendingAskSchema.TargetKind;
    export type TargetKind = PendingAskSchema.TargetKind;

    export const Record = PendingAskSchema.Record;
    export type Record = PendingAskSchema.Record;

    export const Create = PendingAskSchema.Create;
    export type Create = PendingAskSchema.Create;

    export const CorrelationQuery = PendingAskSchema.CorrelationQuery;
    export type CorrelationQuery = PendingAskSchema.CorrelationQuery;

    export const WriteMethod = PendingAskSchema.WriteMethod;
    export type WriteMethod = PendingAskSchema.WriteMethod;

    export const FrozenError = PendingAskSchema.FrozenError;
    export type FrozenError = InstanceType<typeof PendingAskSchema.FrozenError>;

    export const Events = PendingAskSchema.Events;
  }

  export namespace PendingInteraction {
    export const Status = PendingInteractionSchema.Status;
    export type Status = PendingInteractionSchema.Status;

    export const AllowedAction = PendingInteractionSchema.AllowedAction;
    export type AllowedAction = PendingInteractionSchema.AllowedAction;

    export const Correlation = PendingInteractionSchema.Correlation;
    export type Correlation = PendingInteractionSchema.Correlation;

    export const Record = PendingInteractionSchema.Record;
    export type Record = PendingInteractionSchema.Record;

    export const Create = PendingInteractionSchema.Create;
    export type Create = PendingInteractionSchema.Create;

    export const CorrelationQuery = PendingInteractionSchema.CorrelationQuery;
    export type CorrelationQuery = PendingInteractionSchema.CorrelationQuery;

    export const Events = PendingInteractionSchema.Events;
  }

  export namespace WorkerGrant {
    export const Status = WorkerGrantSchema.Status;
    export type Status = WorkerGrantSchema.Status;

    export const Risk = WorkerGrantSchema.Risk;
    export type Risk = WorkerGrantSchema.Risk;

    export const ManagerGrant = WorkerGrantSchema.ManagerGrant;
    export type ManagerGrant = WorkerGrantSchema.ManagerGrant;

    export const Record = WorkerGrantSchema.Record;
    export type Record = WorkerGrantSchema.Record;

    export const Create = WorkerGrantSchema.Create;
    export type Create = WorkerGrantSchema.Create;

    export const Evaluation = WorkerGrantSchema.Evaluation;
    export type Evaluation = WorkerGrantSchema.Evaluation;

    export const EvaluationResult = WorkerGrantSchema.EvaluationResult;
    export type EvaluationResult = WorkerGrantSchema.EvaluationResult;

    export const Events = WorkerGrantSchema.Events;
  }
}
