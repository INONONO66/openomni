import {
  Ingress,
  extractSurfaceKey,
  resolveTarget,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Session, SurfaceKey } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { DEFAULT_DISPATCH_MODEL } from "../dispatch/index.js";

interface ResolvableEvent {
  surface: string;
  workspace?: string;
  channel?: string;
  target?: Ingress.Target;
  activation?: { durableSessionId?: string };
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
  /**
   * Lazy materialization of a router-claimed resident session (#707 stage 2):
   * the gateway minted the sessionId and claimed the surface↔session map
   * before delivering (record-before-act); the brain owns the session ROW and
   * creates it on first Deliver, idempotently. A crash between claim and
   * deliver converges by re-delivery.
   */
  export function materializeResident(
    event: Pick<ResolvableEvent, "surface">,
    sessionId: string,
    traceContext: TraceContextProtocol.Type,
    defaultModel: ModelConfig = {
      providerID: DEFAULT_DISPATCH_MODEL.provider,
      modelID: DEFAULT_DISPATCH_MODEL.id,
    },
  ): ResolveResult {
    const { session, created } = Session.materialize({
      id: sessionId,
      traceId: traceContext.traceId,
      title: `Session from ${event.surface}`,
      model: defaultModel,
    });
    Bus.publish(Ingress.Events.SessionResolved, {
      traceId: traceContext.traceId,
      sessionId: session.id,
      isNew: created,
      target: "resident",
      time: Date.now(),
    });
    return {
      session,
      isNew: created,
      trace: { ...traceContext, sessionId: session.id },
    };
  }

  /**
   * The internal-path + worker-placement resolver. The EXTERNAL resident
   * surface-map ops moved to the gateway router at #707 stage 2; the
   * resident claim loop below now serves only internal events (cron surface
   * sessions) — a recorded brain-side write residue on a perimeter surface,
   * scoped to internal mode which never crosses the perimeter.
   */
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
      const durableSessionId = event.activation?.durableSessionId ?? target.sessionId;
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
      const durableSessionId = event.activation?.durableSessionId;
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

    Bus.publish(Ingress.Events.SessionResolved, {
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
