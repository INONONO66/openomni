import {
  Ingress as IngressNamespace,
  Ingress,
  targetKey,
  type Policy,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { CoordinatorLike } from "./coordinator-like";
import type { DispatchRuntime } from "../dispatch/runtime";
import type { ResidentRuntime } from "../resident/runtime";
import { resolveIngressActor } from "./actor-resolver";
import { IngressEventProjector } from "./event-projector";
import { IngressHandlers } from "./handlers";
import { IngressAuthorityMiddleware } from "./middleware/ingress-authority";
import { IngressSessionResolver } from "./session-resolver";
import {
  executeWaitRoute,
  pinRouteSession,
  pinSelectedTarget,
  requireRoutedDecision,
} from "./routing-execution";
import { resolveAndRecordRoute } from "./routing-resolution";

export type { CoordinatorLike };

export interface AgentResolver {
  resolve(agentName: string, event: Ingress.InternalEvent): Promise<Ingress.AgentDef>;
}

/**
 * Construction-time dependencies of an ingress engine instance (#549). All
 * routing collaborators are injected here — there is no post-construction
 * mutation, so two engines in one process never share configuration.
 */
export interface IngressEngineDeps {
  readonly coordinator?: CoordinatorLike;
  readonly residentRuntime?: Pick<ResidentRuntime, "run">;
  readonly agentResolver?: AgentResolver;
  readonly dispatchRuntime?: DispatchRuntime;
  readonly onPolicyDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
}

export interface IngressEngine {
  ingest(event: unknown): Promise<Ingress.IngressResult>;
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

export function createIngressEngine(deps: IngressEngineDeps = {}): IngressEngine {
  async function ingestResolved(
    inboundEvent: Ingress.ResolvedInboundEvent,
    target: Ingress.Target,
    trace: TraceContextProtocol.Type,
    coordinator: CoordinatorLike | undefined,
    residentRuntime: Pick<ResidentRuntime, "run"> | undefined = deps.residentRuntime,
    signal?: AbortSignal,
  ): Promise<Ingress.IngressResult> {
    const targetLabel = targetKey(target);

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

    const agentModel = inboundEvent.agent.model;
    const { session } = IngressSessionResolver.resolve(inboundEvent, trace, {
      providerID: agentModel.provider,
      modelID: agentModel.id,
    });

    const activeTrace = { ...trace, sessionId: session.id };

    IngressEventProjector.project(
      inboundEvent,
      session.id,
      { providerID: agentModel.provider, modelID: agentModel.id },
      activeTrace,
    );

    const handlerContext = {
      sessionId: session.id,
      event: inboundEvent,
      coordinator,
      residentRuntime,
      traceContext: activeTrace,
      signal,
    };

    if (target.kind === "resident") {
      return IngressHandlers.handleResident(handlerContext);
    }

    return IngressHandlers.handleDirect(handlerContext);
  }

  return {
    async ingest(event: unknown): Promise<Ingress.IngressResult> {
      const externalEvent = IngressNamespace.DirectEventSchema.parse(event);
      const resolvedActorEvent = resolveIngressActor(externalEvent);
      if (resolvedActorEvent.mode !== "direct") {
        throw new TypeError("external ingress actor resolution changed event mode");
      }
      // D11: inherit the trace minted at the channel's first frame — ingress never re-mints.
      const trace = { traceId: externalEvent.traceId };
      const route = resolveAndRecordRoute(resolvedActorEvent, trace.traceId);
      const decision = requireRoutedDecision(route.decision);
      const waitExecution = await executeWaitRoute(deps.dispatchRuntime, trace, route, decision);
      if (waitExecution.kind === "handled") return waitExecution.result;
      if (waitExecution.authority === "wait_precedence") {
        const inboundEvent = pinRouteSession(
          pinSelectedTarget(waitExecution.event, route.selectedTarget),
          decision,
        );
        return ingestResolved(inboundEvent, route.selectedTarget, trace, deps.coordinator);
      }

      const preRun = await IngressAuthorityMiddleware.runRoutedPreRun({
        event: waitExecution.event,
        coordinator: deps.coordinator,
        onDecision: deps.onPolicyDecision,
      });

      const inboundEvent = pinRouteSession(
        pinSelectedTarget(preRun.event, route.selectedTarget),
        decision,
      );
      return ingestResolved(inboundEvent, route.selectedTarget, trace, preRun.coordinator);
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
      const route = resolveAndRecordRoute(event, trace.traceId);
      const decision = requireRoutedDecision(route.decision);
      const waitExecution = await executeWaitRoute(deps.dispatchRuntime, trace, route, decision);
      if (waitExecution.kind === "handled") return waitExecution.result;
      if (waitExecution.event.mode !== "internal") {
        throw new TypeError("internal ingress wait execution changed event mode");
      }
      const agentResolver = options?.agentResolver ?? deps.agentResolver;
      if (!agentResolver) {
        throw new Error("agent resolver not configured");
      }
      const agent = await agentResolver.resolve(event.agentName, event);
      const resolvedEvent = pinRouteSession(
        pinSelectedTarget({ ...waitExecution.event, agent }, route.selectedTarget),
        decision,
      );
      return ingestResolved(
        resolvedEvent,
        route.selectedTarget,
        trace,
        deps.coordinator,
        options?.residentRuntime ?? deps.residentRuntime,
        options?.signal,
      );
    },
  };
}
