import { Ingress } from "@openomni/protocol";
import { Bus, Storage, SurfaceKey } from "@openomni/session";
import type { CoordinatorLike } from "./coordinator-like";
import { IngressEventProjector } from "./event-projector";
import { IngressHandlers } from "./handlers";
import { IngressSessionResolver } from "./session-resolver";

export type { CoordinatorLike };

let _coordinator: CoordinatorLike | undefined;

export namespace IngressEngine {
  export function reset(): void {
    SurfaceKey.clear();
    Storage.reset();
    Bus.reset();
  }

  export function setCoordinator(c: CoordinatorLike): void {
    _coordinator = c;
  }

  export async function ingest(event: Ingress.InboundEvent): Promise<Ingress.IngressResult> {
    if (!_coordinator) {
      throw new Error("coordinator is required");
    }

    Ingress.InboundEventSchema.parse(event);

    const agentModel = event.agent.model;
    const { session } = IngressSessionResolver.resolve(event, {
      providerID: agentModel.provider,
      modelID: agentModel.id,
    });

    IngressEventProjector.project(event, session.id, {
      providerID: agentModel.provider,
      modelID: agentModel.id,
    });

    switch (event.mode) {
      case "plan":
        return IngressHandlers.handlePlan({
          sessionId: session.id,
          event,
          coordinator: _coordinator,
        });
      case "direct":
        return IngressHandlers.handleDirect({
          sessionId: session.id,
          event,
          coordinator: _coordinator,
        });
    }
  }
}
