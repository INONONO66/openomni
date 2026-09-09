import { Ingress, NamedError } from "@openomni/protocol";
import { z } from "zod";

const RoutingErrorCode = z.enum([
  "route_blocked",
  "route_ambiguous",
  "route_record_failed",
  "route_replay_divergent",
  "request_reply_rejected",
]);
type RoutingErrorCode = z.infer<typeof RoutingErrorCode>;

const RoutingErrorBase = NamedError.create(
  "IngressRoutingError",
  NamedError.Unknown.Schema.shape.data.extend({
    code: RoutingErrorCode,
    decision: Ingress.Events.RoutingDecision.schema,
  }),
);

export class IngressRoutingError extends RoutingErrorBase {
  constructor(code: RoutingErrorCode, message: string, decision: Ingress.RoutingDecisionPayload) {
    super({ code, message, decision });
  }

  get code(): RoutingErrorCode {
    return this.data.code;
  }

  get decision(): Ingress.RoutingDecisionPayload {
    return this.data.decision;
  }
}
