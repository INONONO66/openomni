import { Wait } from "@openomni/protocol";
import { ActorRegistry } from "@openomni/ledger";

/**
 * Effectful half of the #215 matcher after the #707 split: the pure core
 * (rule set, evidence extensions, target folds) lives in protocol
 * (`Wait.responderCandidates` and friends); this kernel seam contributes ONLY
 * the ActorRegistry read that anchors a wait's delivery endpoint to its
 * registered actor. The lookup result is an INPUT to the pure core — the
 * caller resolves, the core matches — so a delivery endpoint that no longer
 * resolves still fails closed inside the pure fold (zero candidates).
 */
export function targetsOfWait(record: Wait.Record): Wait.ResponderTarget[] {
  const deliveryEndpointId = record.correlation.endpointId;
  const deliveryActorId =
    deliveryEndpointId === undefined
      ? undefined
      : ActorRegistry.getEndpoint(deliveryEndpointId)?.actorId;
  return Wait.targetsOfWait(record, deliveryActorId);
}
