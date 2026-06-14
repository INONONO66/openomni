import {
  type Ingress,
  IngressEvent,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, Session, SurfaceKey, TraceContext } from "@openomni/session";
import { resolveTarget, targetKey } from "./target";

interface ResolvableEvent {
  surface: string;
  workspace?: string;
  channel?: string;
  target?: Ingress.Target;
  runtime?: { durableSessionId?: string };
  meta?: Ingress.Meta;
}

interface ModelConfig {
  providerID: string;
  modelID: string;
}

interface ResolveResult {
  readonly session: Session.Info;
  readonly isNew: boolean;
  readonly trace?: TraceContextProtocol.Type;
}

export namespace IngressSessionResolver {
  // Format: "surface:workspace:channel" for legacy events. Explicit ADR-008 targets append
  // `target:<target-key>` so resident and worker sessions do not collide.
  export function extractSurfaceKey(event: ResolvableEvent): string {
    const parts = [event.surface, event.workspace ?? "", event.channel ?? ""];
    const target = event.target || event.meta?.target ? resolveTarget(event) : undefined;
    if (target && target.kind !== "resident") {
      parts.push("target", targetKey(target));
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
    const target = resolveTarget(event);
    let session: Session.Info;
    let isNew: boolean;

    if (target.kind === "worker") {
      const durableSessionId = event.runtime?.durableSessionId ?? target.sessionId;
      if (durableSessionId) {
        const existing = Session.get(durableSessionId);
        if (!existing) {
          throw new Error(`worker target session not found: ${durableSessionId}`);
        }
        session = existing;
        isNew = false;
      } else {
        const parentSessionId =
          target.parentSessionId ??
          (typeof event.meta?.actor?.sessionId === "string"
            ? event.meta.actor.sessionId
            : undefined);
        session =
          parentSessionId && Session.get(parentSessionId)
            ? Session.createChild({
                parentSessionId,
                title: `Worker session from ${event.surface}`,
                model: defaultModel,
                workerMeta: { target: "worker", surface: event.surface },
              })
            : Session.create({
                title: `Worker session from ${event.surface}`,
                model: defaultModel,
              });
        isNew = true;
      }
    } else {
      const durableSessionId = event.runtime?.durableSessionId;
      if (durableSessionId) {
        const existing = Session.get(durableSessionId);
        if (!existing) {
          throw new Error(`resident target session not found: ${durableSessionId}`);
        }
        session = existing;
        isNew = false;
      } else {
        const surfaceKey = extractSurfaceKey(event);
        const resolved = resolveResidentSurfaceSession(surfaceKey, event.surface, defaultModel);
        session = resolved.session;
        isNew = resolved.isNew;
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

  function resolveResidentSurfaceSession(
    surfaceKey: string,
    surface: string,
    defaultModel: ModelConfig,
  ): ResolveResult {
    let staleSessionId: string | undefined;
    let lastOwnerSessionId: string | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      const existingSessionId = SurfaceKey.lookup(surfaceKey);
      if (existingSessionId) {
        const existing = Session.get(existingSessionId);
        if (existing) return { session: existing, isNew: false };
        staleSessionId = existingSessionId;
      } else {
        staleSessionId = undefined;
      }

      // Optimistically create a candidate and keep it only if the surface-key
      // claim succeeds; losing candidates are removed below.
      const candidate = Session.create({
        title: `Session from ${surface}`,
        model: defaultModel,
      });
      let ownerSessionId: string;
      try {
        ownerSessionId = SurfaceKey.claim(surfaceKey, candidate.id, staleSessionId);
      } catch (err) {
        Session.remove(candidate.id);
        throw err;
      }
      lastOwnerSessionId = ownerSessionId;
      if (ownerSessionId === candidate.id) {
        return { session: candidate, isNew: true };
      }

      Session.remove(candidate.id);
      const owner = Session.get(ownerSessionId);
      if (owner) return { session: owner, isNew: false };
      staleSessionId = ownerSessionId;
    }

    throw new Error(
      `unable to resolve surface key owner after 3 attempts: ${surfaceKey} lastOwner=${lastOwnerSessionId ?? "unknown"}`,
    );
  }
}
