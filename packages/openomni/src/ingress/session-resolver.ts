import { IngressEvent, type TraceContext as TraceContextProtocol } from "@openomni/protocol";
import { Bus, Session, SurfaceKey, TraceContext } from "@openomni/session";

interface ResolvableEvent {
  surface: string;
  workspace?: string;
  channel?: string;
}

export interface ModelConfig {
  providerID: string;
  modelID: string;
}

export namespace IngressSessionResolver {
  export interface ResolveResult {
    session: Session.Info;
    isNew: boolean;
    trace?: TraceContextProtocol.Type;
  }

  // Format: "surface:workspace:channel" — always 3 positional parts to prevent collisions
  export function extractSurfaceKey(event: ResolvableEvent): string {
    const parts = [event.surface, event.workspace ?? "", event.channel ?? ""];
    return SurfaceKey.create(parts);
  }

  export function resolve(
    event: ResolvableEvent,
    defaultModel: ModelConfig = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    },
    traceContext?: TraceContextProtocol.Type,
  ): ResolveResult {
    const surfaceKey = extractSurfaceKey(event);
    const existingSessionId = SurfaceKey.lookup(surfaceKey);

    let session: Session.Info;
    let isNew: boolean;

    if (existingSessionId) {
      const existing = Session.get(existingSessionId);
      if (existing) {
        session = existing;
        isNew = false;
      } else {
        // Stale entry — session was deleted, create new
        session = Session.create({ title: `Session from ${event.surface}`, model: defaultModel });
        SurfaceKey.register(surfaceKey, session.id);
        isNew = true;
      }
    } else {
      session = Session.create({ title: `Session from ${event.surface}`, model: defaultModel });
      SurfaceKey.register(surfaceKey, session.id);
      isNew = true;
    }

    if (traceContext) {
      Bus.publish(IngressEvent.SessionResolved, {
        traceId: traceContext.traceId,
        sessionId: session.id,
        isNew,
        time: Date.now(),
      });
      return { session, isNew, trace: TraceContext.child(traceContext, { sessionId: session.id }) };
    }

    return { session, isNew };
  }
}
