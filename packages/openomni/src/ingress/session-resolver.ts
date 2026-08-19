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

/**
 * Gateway port for surface↔session stickiness claims (#708): CAS semantics —
 * with `expectedSessionId` the claim replaces only that owner; without it, it
 * inserts only when absent; the returned id is the owner AFTER the attempt.
 * The brain holds no direct SurfaceKey WRITE since #708 — the composition
 * root injects the gateway router's `claimSurface`, making the gateway the
 * literal sole writer of the perimeter surface (reads stay recorded residue).
 */
export type SurfaceSessionClaim = (
  surfaceKey: string,
  sessionId: string,
  expectedSessionId?: string,
) => string;

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
   * sessions) and claims through the injected gateway port (#708) — the
   * brain writes no perimeter surface directly.
   */
  export function resolve(
    event: ResolvableEvent,
    traceContext: TraceContextProtocol.Type,
    defaultModel: ModelConfig = {
      providerID: DEFAULT_DISPATCH_MODEL.provider,
      modelID: DEFAULT_DISPATCH_MODEL.id,
    },
    claimSurface?: SurfaceSessionClaim,
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
        // Fail closed (audit A T6): an ASSERTED parent session id that does
        // not exist must throw, matching the sibling worker/resident
        // durable-session arms above — never silently fall through to a fresh
        // orphan root session.
        if (parentSessionId !== undefined && !Session.get(parentSessionId)) {
          throw new Error(`worker parent session not found: ${parentSessionId}`);
        }
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
          claimSurface,
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
    claimSurface: SurfaceSessionClaim | undefined,
  ): ResolvedSession {
    // Fail closed (#708): without the gateway port there is no legal way to
    // write the surface↔session map — the brain never falls back to a direct
    // ledger write.
    if (claimSurface === undefined) {
      throw new Error(
        "surface claim port not configured — resident surface sessions fail closed " +
          "(#708: internal claims route through the gateway claimSurface port)",
      );
    }
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
        ownerSessionId = claimSurface(surfaceKey, candidate.id, staleSessionId);
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
