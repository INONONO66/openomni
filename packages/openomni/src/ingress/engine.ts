import { PolicyEngine, type PolicyDecision } from "@openomni/policy";
import type { PolicyRegistration } from "@openomni/agent";
import {
  Ingress as IngressNamespace,
  type Ingress,
  type Policy,
  IngressEvent,
  PolicyDecision as Decision,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, TraceContext } from "@openomni/session";
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
import { targetKey } from "./target";

export type { CoordinatorLike };

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

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
  readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
  readonly policies?: readonly PolicyRegistration[];
}

export interface IngressEngine {
  ingest(event: unknown): Promise<Ingress.IngressResult>;
  ingestInternal(
    event: Ingress.InternalEvent,
    runtime?: Readonly<{
      residentRuntime?: Pick<ResidentRuntime, "run">;
      agentResolver?: AgentResolver;
    }>,
  ): Promise<Ingress.IngressResult>;
}

function assertInboundReceiveAllowed(decision: Policy.PolicyDecision): void {
  if (!Decision.isBlocking(decision)) return;
  throw new Error(Decision.reason(decision, "inbound.receive policy denied"));
}

export function createIngressEngine(deps: IngressEngineDeps = {}): IngressEngine {
  const ingressPolicies: readonly PolicyRegistration[] = [...(deps.policies ?? [])];

  async function ingestResolved(
    inboundEvent: Ingress.ResolvedInboundEvent,
    target: Ingress.Target,
    trace: TraceContextProtocol.Type,
    coordinator: CoordinatorLike | undefined,
    residentRuntime: Pick<ResidentRuntime, "run"> | undefined = deps.residentRuntime,
  ): Promise<Ingress.IngressResult> {
    const targetLabel = targetKey(target);

    const payloadLength =
      typeof inboundEvent.payload === "string"
        ? inboundEvent.payload.length
        : (JSON.stringify(inboundEvent.payload ?? null) ?? "").length;

    Bus.publish(IngressEvent.Received, {
      traceId: trace.traceId,
      surface: inboundEvent.surface,
      mode: inboundEvent.mode,
      ...(targetLabel ? { target: targetLabel } : {}),
      payloadLength,
      time: Date.now(),
    });

    if (ingressPolicies.length > 0) {
      const engine = PolicyEngine.create({
        traceContext: trace,
        onDecision: deps.onPolicyDecision,
        auditEmit: Bus.publish,
      });
      for (const reg of ingressPolicies) {
        engine.register(reg);
      }

      const labels: Policy.LabelEntry[] = [
        { value: `surface.${inboundEvent.surface}`, source: "system" },
        { value: `target.${target.kind}`, source: "system" },
      ];
      if (typeof inboundEvent.meta?.inboundTreatment === "string") {
        labels.push({
          value: `inbound.${inboundEvent.meta.inboundTreatment}`,
          source: "system",
        });
      }
      const role = inboundEvent.meta?.actor?.role;
      if (role) labels.push({ value: `actor.${role}`, source: "system" });

      const decision = await engine.dispatch("inbound.receive", {
        steps: [],
        usage: emptyUsage,
        turnCount: 0,
        isCompletion: false,
        continuationCount: 0,
        elapsedMs: 0,
        labels,
        toolInput: {
          actor: inboundEvent.meta?.actor,
          surface: inboundEvent.surface,
          mode: inboundEvent.mode,
          target: target.kind,
          inboundTreatment: inboundEvent.meta?.inboundTreatment,
          channelGrantId: inboundEvent.meta?.channelGrantId,
          channelGrantKind: inboundEvent.meta?.channelGrantKind,
        },
        traceContext: trace,
      });

      assertInboundReceiveAllowed(decision);
    }

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

    const handlerContext = {
      sessionId: session.id,
      event: inboundEvent,
      coordinator,
      residentRuntime,
      traceContext: activeTrace,
      policies: ingressPolicies,
      onPolicyDecision: deps.onPolicyDecision,
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
      const trace = TraceContext.create();
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
        traceContext: trace,
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
      runtime?: Readonly<{
        residentRuntime?: Pick<ResidentRuntime, "run">;
        agentResolver?: AgentResolver;
      }>,
    ): Promise<Ingress.IngressResult> {
      const trace = TraceContext.create();
      const route = resolveAndRecordRoute(event, trace.traceId);
      const decision = requireRoutedDecision(route.decision);
      const waitExecution = await executeWaitRoute(deps.dispatchRuntime, trace, route, decision);
      if (waitExecution.kind === "handled") return waitExecution.result;
      if (waitExecution.event.mode !== "internal") {
        throw new TypeError("internal ingress wait execution changed event mode");
      }
      const agentResolver = runtime?.agentResolver ?? deps.agentResolver;
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
        runtime?.residentRuntime ?? deps.residentRuntime,
      );
    },
  };
}
