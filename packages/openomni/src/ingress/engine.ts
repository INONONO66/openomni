import type { MiddlewareDecision } from "@openomni/agent";
import { type Ingress, IngressEvent } from "@openomni/protocol";
import { Bus, Storage, SurfaceKey, TraceContext } from "@openomni/session";
import type { CoordinatorLike } from "./coordinator-like";
import { IngressEventProjector } from "./event-projector";
import { IngressHandlers } from "./handlers";
import { IngressAuthorityMiddleware } from "./middleware/ingress-authority";
import { IngressSessionResolver } from "./session-resolver";

export type { CoordinatorLike };

let _coordinator: CoordinatorLike | undefined;
let _middlewareDecisionObserver:
  | ((decision: MiddlewareDecision) => void | Promise<void>)
  | undefined;

export namespace IngressEngine {
  export function reset(): void {
    SurfaceKey.clear();
    Storage.reset();
    Bus.reset();
    _coordinator = undefined;
    _middlewareDecisionObserver = undefined;
  }

  export function setCoordinator(c: CoordinatorLike): void {
    _coordinator = c;
  }

  export function clearCoordinator(): void {
    _coordinator = undefined;
  }

  export function setMiddlewareDecisionObserver(
    observer: ((decision: MiddlewareDecision) => void | Promise<void>) | undefined,
  ): void {
    _middlewareDecisionObserver = observer;
  }

  export async function ingest(event: Ingress.InboundEvent): Promise<Ingress.IngressResult> {
    const trace = TraceContext.create();
    const preRun = await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: _coordinator,
      traceContext: trace,
      onDecision: _middlewareDecisionObserver,
    });

    const inboundEvent = preRun.event;

    const payloadLength =
      typeof inboundEvent.payload === "string"
        ? inboundEvent.payload.length
        : (JSON.stringify(inboundEvent.payload ?? null) ?? "").length;

    Bus.publish(IngressEvent.Received, {
      traceId: trace.traceId,
      surface: inboundEvent.surface,
      mode: inboundEvent.mode,
      payloadLength,
      time: Date.now(),
    });

    const agentModel = inboundEvent.agent.model;
    const { session } = IngressSessionResolver.resolve(
      inboundEvent,
      { providerID: agentModel.provider, modelID: agentModel.id },
      trace,
    );

    const activeTrace = TraceContext.child(trace, { sessionId: session.id });

    IngressEventProjector.project(
      inboundEvent,
      session.id,
      { providerID: agentModel.provider, modelID: agentModel.id },
      activeTrace,
    );

    return IngressHandlers.handleDirect({
      sessionId: session.id,
      event: inboundEvent,
      coordinator: preRun.coordinator,
      traceContext: activeTrace,
    });
  }
}
