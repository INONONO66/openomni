import { Ingress, IngressEvent } from "@openomni/protocol";
import { Bus, Log, Storage, SurfaceKey, TraceContext } from "@openomni/session";
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

    const trace = TraceContext.create();
    const log = Log.withContext({ traceId: trace.traceId });
    log.info("ingress received", { surface: event.surface, mode: event.mode });

    const payloadLength =
      typeof event.payload === "string"
        ? event.payload.length
        : JSON.stringify(event.payload).length;

    Bus.publish(IngressEvent.Received, {
      traceId: trace.traceId,
      surface: event.surface,
      mode: event.mode,
      payloadLength,
      time: Date.now(),
    });

    const agentModel = event.agent.model;
    const { session, trace: resolvedTrace } = IngressSessionResolver.resolve(
      event,
      { providerID: agentModel.provider, modelID: agentModel.id },
      trace,
    );

    const activeTrace = resolvedTrace ?? TraceContext.child(trace, { sessionId: session.id });

    IngressEventProjector.project(
      event,
      session.id,
      { providerID: agentModel.provider, modelID: agentModel.id },
      activeTrace,
    );

    switch (event.mode) {
      case "plan":
        return IngressHandlers.handlePlan({
          sessionId: session.id,
          event,
          coordinator: _coordinator,
          traceContext: activeTrace,
        });
      case "direct":
        return IngressHandlers.handleDirect({
          sessionId: session.id,
          event,
          coordinator: _coordinator,
          traceContext: activeTrace,
        });
    }
  }
}
