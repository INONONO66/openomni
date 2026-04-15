import { InboundEventSchema, type InboundEvent, type IngressResult } from "@openomni/protocol";
import { Bus, Storage, SurfaceKey } from "@openomni/session";
import { IngressEventProjector } from "./event-projector";
import { IngressHandlers } from "./handlers";
import { IngressSessionResolver } from "./session-resolver";

export namespace IngressEngine {
  export function reset(): void {
    SurfaceKey.clear();
    Storage.reset();
    Bus.reset();
  }

  export async function ingest(event: InboundEvent): Promise<IngressResult> {
    InboundEventSchema.parse(event);

    const agentModel = event.agent.model;
    const { session } = IngressSessionResolver.resolve(event, {
      providerID: agentModel.provider,
      modelID: agentModel.id,
    });

    IngressEventProjector.project(event, session.id);

    switch (event.mode) {
      case "plan":
        return IngressHandlers.handlePlan({ sessionId: session.id, event });
      case "direct":
        return IngressHandlers.handleDirect({ sessionId: session.id, event });
    }
  }
}
