import * as PendingAskSchema from "./pending-ask.js";
import * as PendingInteractionSchema from "./pending-interaction.js";

export namespace Communication {
  /** Frozen-store read surface (#498 C4): Record/Status/CorrelationQuery for reads, FrozenError for the typed write refusal. */
  export namespace PendingAsk {
    export const Status = PendingAskSchema.Status;
    export type Status = PendingAskSchema.Status;

    export const Record = PendingAskSchema.Record;
    export type Record = PendingAskSchema.Record;

    export const CorrelationQuery = PendingAskSchema.CorrelationQuery;
    export type CorrelationQuery = PendingAskSchema.CorrelationQuery;

    export const FrozenError = PendingAskSchema.FrozenError;
    export type FrozenError = InstanceType<typeof PendingAskSchema.FrozenError>;
  }

  /** Frozen-store read surface (#498 C4): Record/Status/AllowedAction/CorrelationQuery for reads, FrozenError for the typed write refusal. */
  export namespace PendingInteraction {
    export const Status = PendingInteractionSchema.Status;
    export type Status = PendingInteractionSchema.Status;

    export const AllowedAction = PendingInteractionSchema.AllowedAction;
    export type AllowedAction = PendingInteractionSchema.AllowedAction;

    export const Record = PendingInteractionSchema.Record;
    export type Record = PendingInteractionSchema.Record;

    export const CorrelationQuery = PendingInteractionSchema.CorrelationQuery;
    export type CorrelationQuery = PendingInteractionSchema.CorrelationQuery;

    export const FrozenError = PendingInteractionSchema.FrozenError;
    export type FrozenError = InstanceType<typeof PendingInteractionSchema.FrozenError>;
  }
}
