import {
  Gateway,
  Ingress,
  resolveTarget,
  targetKey,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { CoordinatorLike } from "./coordinator-like";
import type { DispatchRuntime } from "../dispatch/runtime";
import type { ResidentRuntime } from "../resident/runtime";
import { IngressEventProjector } from "./event-projector";
import { IngressHandlers } from "./handlers";
import { IngressSessionResolver, type SurfaceSessionClaim } from "./session-resolver";
import { executePendingInteractionDelivery } from "./pending-interaction-delivery";
import { requireRoutedInternalDecision, resolveAndRecordInternalRoute } from "./internal-route";

export type { CoordinatorLike };

export interface AgentResolver {
  resolve(agentName: string, event: Ingress.InternalEvent): Promise<Ingress.AgentDef>;
}

/**
 * Construction-time dependencies of the brain engine (#549 discipline, #707
 * shape). All collaborators are injected here — there is no post-construction
 * mutation, so two engines in one process never share configuration.
 */
export interface BrainEngineDeps {
  readonly coordinator?: CoordinatorLike;
  readonly residentRuntime?: Pick<ResidentRuntime, "run">;
  /** Internal-path agent resolution (cron fire, dispatch resident.ask). */
  readonly agentResolver?: AgentResolver;
  readonly dispatchRuntime?: DispatchRuntime;
  /**
   * External-delivery agent resolution (#707): the perimeter no longer embeds
   * brain material on the inbound event — the Deliver consumer resolves the
   * resident AgentDef itself. The composition root binds the SAME resident
   * construction the channel bridge used to embed (same prompt family, same
   * tool catalog, same runtime model resolution) — same behavior, new home.
   */
  readonly externalAgentResolver?: (event: Gateway.DeliveredEvent) => Promise<Ingress.AgentDef>;
  /**
   * Gateway port for internal-mode surface↔session stickiness claims (#708,
   * closing the #707 residue): the composition root binds the router's
   * `claimSurface`; the brain writes no perimeter surface directly. Absent →
   * internal resident surface sessions fail closed at claim time.
   */
  readonly claimSurface?: SurfaceSessionClaim;
}

/**
 * The brain engine (#707 stage 2): the gateway router's Deliver consumer plus
 * the internal ingress path. External events reach `deliver` through the
 * router's injected port (Gateway.Deliver, parsed at the seam); internal
 * events (cron, dispatch resident.ask) never cross the perimeter and enter
 * through `ingestInternal` with the brain's own resolver + route.decided
 * recording path.
 */
export interface BrainEngine {
  deliver(delivery: unknown): Promise<Ingress.IngressResult>;
  ingestInternal(
    event: Ingress.InternalEvent,
    options?: Readonly<{
      residentRuntime?: Pick<ResidentRuntime, "run">;
      agentResolver?: AgentResolver;
      /**
       * #500 A2: live in-process abort for the resident run — an AbortSignal
       * is not serializable, so it rides the call path, never the event.
       */
      signal?: AbortSignal;
    }>,
  ): Promise<Ingress.IngressResult>;
}

function pinSessionFromDecision<Event extends Ingress.ResolvedInboundEvent>(
  event: Event,
  sessionId: string | undefined,
): Event {
  if (sessionId === undefined) return event;
  return {
    ...event,
    activation: {
      ...event.activation,
      durableSessionId: sessionId,
    },
  };
}

export function createBrainEngine(deps: BrainEngineDeps = {}): BrainEngine {
  function publishReceived(
    inboundEvent: Ingress.ResolvedInboundEvent,
    trace: TraceContextProtocol.Type,
  ): void {
    const targetLabel = targetKey(resolveTarget(inboundEvent));
    const payloadLength =
      typeof inboundEvent.payload === "string"
        ? inboundEvent.payload.length
        : (JSON.stringify(inboundEvent.payload ?? null) ?? "").length;

    Bus.publish(Ingress.Events.Received, {
      traceId: trace.traceId,
      surface: inboundEvent.surface,
      mode: inboundEvent.mode,
      ...(targetLabel ? { target: targetLabel } : {}),
      payloadLength,
      time: Date.now(),
    });
  }

  /** Projection + handler dispatch — the shared tail of both paths. */
  async function executeResolved(
    inboundEvent: Ingress.ResolvedInboundEvent,
    target: Ingress.Target,
    sessionId: string,
    trace: TraceContextProtocol.Type,
    coordinator: CoordinatorLike | undefined,
    residentRuntime: Pick<ResidentRuntime, "run"> | undefined,
    signal?: AbortSignal,
    delivery?: Readonly<{
      /** #709: the delivery's wait resumption context — rehydration point + engagement id. */
      waitContext?: Gateway.WaitContext;
      /** #709: the delivery's perimeter trust verdict — the engagement approval gate's input. */
      actorTrustTier?: string;
      /**
       * S6 — the delivery's perimeter inbound treatment
       * (Gateway.ActorContext.inboundTreatment), consumed verbatim per
       * gateway-design §3. Two consumers: (1) the HARD authority gate — an
       * `evidence_only` run's tool permission is forced deny-all so the turn
       * cannot drive tool use, whatever the plan allows; (2) the projection
       * seam frames the turn as an observation (defense-in-depth). Together
       * they make the batch-① recovery floor load-bearing.
       */
      inboundTreatment?: string;
    }>,
  ): Promise<Ingress.IngressResult> {
    const agentModel = inboundEvent.agent.model;
    const activeTrace = { ...trace, sessionId };

    IngressEventProjector.project(
      inboundEvent,
      sessionId,
      { providerID: agentModel.provider, modelID: agentModel.id },
      activeTrace,
      delivery?.inboundTreatment,
    );

    const handlerContext = {
      sessionId,
      event: inboundEvent,
      coordinator,
      residentRuntime,
      traceContext: activeTrace,
      signal,
      waitContext: delivery?.waitContext,
      actorTrustTier: delivery?.actorTrustTier,
      inboundTreatment: delivery?.inboundTreatment,
    };

    if (target.kind === "resident") {
      return IngressHandlers.handleResident(handlerContext);
    }

    return IngressHandlers.handleDirect(handlerContext);
  }

  return {
    /**
     * The Deliver consumer (gateway → brain). The delivery is parsed at the
     * seam (trust but validate shape); the routed event is executed with the
     * brain-resolved resident AgentDef. Worker-target deliveries need a
     * coordinator — the presence check that historically lived in the routed
     * pre-run middleware runs here since the seam flip (same behavior, new
     * home).
     */
    async deliver(input: unknown): Promise<Ingress.IngressResult> {
      const delivery = Gateway.Deliver.parse(input);
      const event = delivery.event;
      const decision = delivery.decision;
      // D11: inherit the trace minted at the channel's first frame.
      const trace = { traceId: event.traceId };
      const resolveAgent = deps.externalAgentResolver;
      if (resolveAgent === undefined) {
        throw new Error("external agent resolver not configured");
      }
      const agent = await resolveAgent(event);
      const resolvedEvent: Ingress.ResolvedInboundEvent = { ...event, agent };

      if (
        decision.outcome === "route" &&
        decision.stage === "wait_correlation" &&
        decision.pendingInteractionId !== undefined
      ) {
        // Dispatch work placement (§8.5): no session, no projection — the
        // pinned dispatch command is the whole execution, as before the flip.
        return executePendingInteractionDelivery(
          deps.dispatchRuntime,
          trace,
          resolvedEvent,
          decision,
        );
      }

      // The delivered event already carries the router's pins (selected
      // target + routed session on activation) — it is the post-pin event of
      // the pre-flip pipeline, re-used verbatim.
      const target = resolveTarget(resolvedEvent);
      if (target.kind !== "resident" && deps.coordinator === undefined) {
        throw new Error(`coordinator is required for ${target.kind} target`);
      }

      publishReceived(resolvedEvent, trace);

      const agentModel = resolvedEvent.agent.model;
      const model = { providerID: agentModel.provider, modelID: agentModel.id };
      let sessionId: string;
      if (target.kind === "resident") {
        // Lazy materialization on first Deliver (#707 ruling): the router
        // minted the label and claimed the surface map before delivering;
        // the brain owns the session ROW and creates it if absent. A crash
        // between claim and deliver converges by re-delivery.
        const routedSessionId = delivery.sessionId;
        if (routedSessionId === undefined) {
          throw new TypeError("resident delivery without a routed sessionId");
        }
        sessionId = IngressSessionResolver.materializeResident(
          resolvedEvent,
          routedSessionId,
          trace,
          model,
        ).session.id;
      } else {
        // Worker placement stays brain judgment: the delivered event carries
        // the pinned activation/target facts and the resolver selects or
        // creates the worker session exactly as before the flip.
        sessionId = IngressSessionResolver.resolve(resolvedEvent, trace, model, deps.claimSurface)
          .session.id;
      }

      return executeResolved(
        resolvedEvent,
        target,
        sessionId,
        trace,
        deps.coordinator,
        deps.residentRuntime,
        undefined,
        // #709: the seam's waitContext/actorContext verdicts flow to the run —
        // waitContext.engagementId is the rehydration point, trustTier the
        // approval gate's input (consumed verbatim, gateway-design §3).
        {
          waitContext: delivery.waitContext,
          actorTrustTier: delivery.actorContext?.trustTier,
          inboundTreatment: delivery.actorContext?.inboundTreatment,
        },
      );
    },

    async ingestInternal(
      event: Ingress.InternalEvent,
      options?: Readonly<{
        residentRuntime?: Pick<ResidentRuntime, "run">;
        agentResolver?: AgentResolver;
        signal?: AbortSignal;
      }>,
    ): Promise<Ingress.IngressResult> {
      // D11: inherit the producer's trace (cron fire, dispatch command) — ingress never re-mints.
      const trace = { traceId: event.traceId };
      const route = resolveAndRecordInternalRoute(event, trace.traceId);
      const decision = requireRoutedInternalDecision(route.decision);
      if (decision.stage === "blacklist" && decision.outcome === "drop") {
        return {
          kind: "dropped",
          mode: event.mode,
          target: route.selectedTarget,
          reason: decision.reason,
        };
      }
      const agentResolver = options?.agentResolver ?? deps.agentResolver;
      if (!agentResolver) {
        throw new Error("agent resolver not configured");
      }
      const agent = await agentResolver.resolve(event.agentName, event);
      const resolvedEvent = pinSessionFromDecision(
        { ...event, agent, target: route.selectedTarget },
        decision.sessionId,
      );
      publishReceived(resolvedEvent, trace);
      const agentModel = resolvedEvent.agent.model;
      const { session } = IngressSessionResolver.resolve(
        resolvedEvent,
        trace,
        {
          providerID: agentModel.provider,
          modelID: agentModel.id,
        },
        deps.claimSurface,
      );
      return executeResolved(
        resolvedEvent,
        route.selectedTarget,
        session.id,
        trace,
        deps.coordinator,
        options?.residentRuntime ?? deps.residentRuntime,
        options?.signal,
      );
    },
  };
}
