import {
  Ingress,
  IngressEvent,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, Session, SurfaceKey, TraceContext } from "@openomni/session";

interface ResolvableEvent {
  surface: string;
  workspace?: string;
  channel?: string;
  target?: Ingress.Target;
  runtime?: { durableSessionId?: string };
  meta?: Ingress.Meta;
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

  // Format: "surface:workspace:channel" for legacy events. Explicit ADR-008 targets append
  // `target:<target-key>` so main, new-worker, and worker sessions do not collide.
  export function extractSurfaceKey(event: ResolvableEvent): string {
    const parts = [event.surface, event.workspace ?? "", event.channel ?? ""];
    const target = event.target || event.meta?.target ? Ingress.resolveTarget(event) : undefined;
    if (target && target.kind !== "main") {
      parts.push("target", Ingress.targetKey(target));
    }
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
    const target = Ingress.resolveTarget(event);
    let session: Session.Info;
    let isNew: boolean;

    if (target.kind === "new-worker") {
      const parentSessionId =
        target.parentSessionId ??
        (typeof event.meta?.actor?.sessionId === "string" ? event.meta.actor.sessionId : undefined);
      session =
        parentSessionId && Session.get(parentSessionId)
          ? Session.createChild({
              parentSessionId,
              title: `Worker session from ${event.surface}`,
              model: defaultModel,
              workerMeta: { target: "new-worker", surface: event.surface },
            })
          : Session.create({
              title: `Worker session from ${event.surface}`,
              model: defaultModel,
            });
      isNew = true;
    } else if (target.kind === "worker") {
      if (!target.sessionId) {
        throw new Error("worker target requires existing sessionId");
      }
      const existing = Session.get(target.sessionId);
      if (!existing) {
        throw new Error(`worker target session not found: ${target.sessionId}`);
      }
      session = existing;
      isNew = false;
    } else {
      const durableSessionId = event.runtime?.durableSessionId;
      if (durableSessionId) {
        const existing = Session.get(durableSessionId);
        if (!existing) {
          throw new Error(`main target session not found: ${durableSessionId}`);
        }
        session = existing;
        isNew = false;
      } else {
        const surfaceKey = extractSurfaceKey(event);
        const existingSessionId = SurfaceKey.lookup(surfaceKey);

        if (existingSessionId) {
          const existing = Session.get(existingSessionId);
          if (existing) {
            session = existing;
            isNew = false;
          } else {
            // Stale entry — session was deleted, create new
            session = Session.create({
              title: `Session from ${event.surface}`,
              model: defaultModel,
            });
            SurfaceKey.register(surfaceKey, session.id);
            isNew = true;
          }
        } else {
          session = Session.create({ title: `Session from ${event.surface}`, model: defaultModel });
          SurfaceKey.register(surfaceKey, session.id);
          isNew = true;
        }
      }
    }

    if (traceContext) {
      Bus.publish(IngressEvent.SessionResolved, {
        traceId: traceContext.traceId,
        sessionId: session.id,
        isNew,
        target: target.kind,
        time: Date.now(),
      });
      return { session, isNew, trace: TraceContext.child(traceContext, { sessionId: session.id }) };
    }

    return { session, isNew };
  }
}
