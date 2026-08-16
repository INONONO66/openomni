import {
  Adapter,
  type Ingress,
  IngressEvent,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Session, SurfaceKey } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { DEFAULT_DISPATCH_MODEL } from "../dispatch/index.js";
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

interface ResolvedSession {
  session: Session.Info;
  isNew: boolean;
}

interface ResolveResult extends ResolvedSession {
  trace: TraceContextProtocol.Type;
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
    return Adapter.SurfaceKey.create(parts);
  }

  export function resolve(
    event: ResolvableEvent,
    traceContext: TraceContextProtocol.Type,
    defaultModel: ModelConfig = {
      providerID: DEFAULT_DISPATCH_MODEL.provider,
      modelID: DEFAULT_DISPATCH_MODEL.id,
    },
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
                traceId: traceContext.traceId,
                parentSessionId,
                title: `Worker session from ${event.surface}`,
                model: defaultModel,
                workerMeta: { target: "worker", surface: event.surface },
              })
            : Session.create({
                traceId: traceContext.traceId,
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
        const resolved = resolveResidentSurfaceSession(
          surfaceKey,
          event.surface,
          defaultModel,
          traceContext.traceId,
        );
        session = resolved.session;
        isNew = resolved.isNew;
      }
    }

    Bus.publish(IngressEvent.SessionResolved, {
      traceId: traceContext.traceId,
      sessionId: session.id,
      isNew,
      target: target.kind,
      time: Date.now(),
    });
    return { session, isNew, trace: { ...traceContext, sessionId: session.id } };
  }

  function resolveResidentSurfaceSession(
    surfaceKey: string,
    surface: string,
    defaultModel: ModelConfig,
    traceId: string,
  ): ResolvedSession {
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
        traceId,
        title: `Session from ${surface}`,
        model: defaultModel,
      });
      let ownerSessionId: string;
      try {
        ownerSessionId = SurfaceKey.claim(surfaceKey, candidate.id, staleSessionId);
      } catch (err) {
        Session.remove(candidate.id, traceId);
        throw err;
      }
      lastOwnerSessionId = ownerSessionId;
      if (ownerSessionId === candidate.id) {
        return { session: candidate, isNew: true };
      }

      Session.remove(candidate.id, traceId);
      const owner = Session.get(ownerSessionId);
      if (owner) return { session: owner, isNew: false };
      staleSessionId = ownerSessionId;
    }

    throw new Error(
      `unable to resolve surface key owner after 3 attempts: ${surfaceKey} lastOwner=${lastOwnerSessionId ?? "unknown"}`,
    );
  }
}
