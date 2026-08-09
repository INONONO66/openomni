import * as Fold from "./fold.js";
import * as Schema from "./schema.js";

/**
 * Transcript domain (#545 T1): append-only conversation-history facts and the
 * pure fold projecting them into Message.WithParts. Bus event descriptors
 * intentionally do not exist yet — they land with their first consumer (T5).
 */
export namespace Transcript {
  export const Usage = Schema.Usage;
  export type Usage = Schema.Usage;

  export const PartTransition = Schema.PartTransition;
  export type PartTransition = Schema.PartTransition;

  export const FinishReason = Schema.FinishReason;
  export type FinishReason = Schema.FinishReason;

  export const Fact = Schema.Fact;
  export type Fact = Schema.Fact;

  export const RejectReason = Fold.RejectReason;
  export type RejectReason = Fold.RejectReason;

  export type FoldOutcome = Fold.FoldOutcome;

  export const fold = Fold.fold;
}
