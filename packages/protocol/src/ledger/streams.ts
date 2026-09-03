import { z } from "zod";

/**
 * `route.not_delivered` fact data (batch ② commit 4): the correcting fact for
 * a routed wait-correlated inbound whose reply was rejected fail-closed at the
 * wait fold and dropped. Recorded on the `route_correction:<scope>:<id>`
 * stream so the ledger reflects the non-delivery the route.decided fact would
 * otherwise misreport as a completed route.
 */
export const RouteNotDelivered = z
  .object({
    inboundId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type RouteNotDelivered = z.infer<typeof RouteNotDelivered>;
