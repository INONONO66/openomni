import { PolicyEngine, type PolicyDecision } from "@openomni/policy";
import type { PolicyRegistration } from "@openomni/agent";
import {
  Ingress as IngressNamespace,
  type Ingress,
  type Policy,
  IngressEvent,
  PolicyDecision as Decision,
  type RoutingDecisionPayload,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, Storage, SurfaceKey, TraceContext } from "@openomni/session";
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
  IngressRoutingError,
  pinRouteSession,
  pinSelectedTarget,
  requireRoutedDecision,
} from "./routing-execution";
import { resolveKernelRoute, type KernelRouteResolution } from "./routing-runtime";
import { targetKey } from "./target";

export type { CoordinatorLike };

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export interface AgentResolver {
  resolve(agentName: string, event: Ingress.InternalEvent): Promise<Ingress.AgentDef>;
}

let _coordinator: CoordinatorLike | undefined;
let _residentRuntime: ResidentRuntime | undefined;
let _middlewareDecisionObserver: ((decision: PolicyDecision) => void | Promise<void>) | undefined;
let _ingressPolicies: PolicyRegistration[] = [];
let _agentResolver: AgentResolver | undefined;
let _dispatchRuntime: DispatchRuntime | undefined;

function assertInboundReceiveAllowed(decision: Policy.PolicyDecision): void {
  if (!Decision.isBlocking(decision)) return;
  throw new Error(Decision.reason(decision, "inbound.receive policy denied"));
}

// #510 C3 ruling 1 — the routing decision is a decision-class fact on the
// single-fact owner stream `route:<inboundEventId>` (expectedHead 0), awaited
// durably BEFORE anything acts on the decision: the observe-only Bus publish,
// the typed terminal rejection, and wait/handler execution all follow the
// append. No record, no action — with one deliberate replay carve-out: a
// cas_conflict means this inbound id was ALREADY decided, and a redelivered
// inbound is not a new decision to refuse but the same recorded decision to
// replay (#519 attach/deliver crash-window recovery). The recorded
// route.decided fact is read back and re-executed: an accepted route re-runs
// the routed action idempotently (the wait fold's already_resolved
// short-circuit re-delivers to the owner), a terminal decision repeats the
// same typed rejection it originally produced. Only append INFRASTRUCTURE
// failure (missing sub-adapter, failed append/read, foreign or unparsable
// recorded fact) fails closed as route_record_failed.
function recordRouteDecided(decision: RoutingDecisionPayload): RoutingDecisionPayload {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw new IngressRoutingError(
      "route_record_failed",
      "Storage adapter does not implement ledger append — routing decisions fail closed",
      decision,
    );
  }
  const streamId = `route:${decision.inboundId}`;
  let appended: ReturnType<typeof ledger.append>;
  try {
    appended = ledger.append({ streamId, type: "route.decided", data: decision }, 0);
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `routing decision append failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
  if (appended.kind === "appended") return decision;
  try {
    const recorded = ledger.headFact(streamId);
    if (recorded === undefined || recorded.type !== "route.decided") {
      throw new Error(`stream ${streamId} conflicted without a recorded route.decided fact`);
    }
    return IngressEvent.RoutingDecision.schema.parse(recorded.data);
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `recorded routing decision read failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
}

// Correlation is read-only (#215): wait ambiguity is recorded solely by the
// appended route.decided fact, its published RoutingDecision projection, and
// the typed route_ambiguous rejection — frozen legacy rows are never mutated
// on lookup.
function resolveAndRecordRoute<Event extends Ingress.InboundEvent>(
  event: Event,
  traceId: string,
): KernelRouteResolution<Event> {
  const resolution = resolveKernelRoute(event, traceId);
  const decision = IngressEvent.RoutingDecision.schema.parse(resolution.decision);
  // On replay the RECORDED decision governs execution, not the fresh resolve —
  // conditions that changed between deliveries cannot flip a decided route.
  const effective = recordRouteDecided(decision);
  // Observe-only projection of the recorded fact — strictly after the append
  // (or its replay read); lossy by contract.
  Bus.publish(IngressEvent.RoutingDecision, effective);
  return { ...resolution, decision: effective };
}

export namespace IngressEngine {
  export function reset(): void {
    SurfaceKey.clear();
    Storage.reset();
    Bus.reset();
    _coordinator = undefined;
    _residentRuntime = undefined;
    _middlewareDecisionObserver = undefined;
    _ingressPolicies = [];
    _agentResolver = undefined;
    _dispatchRuntime = undefined;
  }

  export function setCoordinator(c: CoordinatorLike): void {
    _coordinator = c;
  }

  export function clearCoordinator(): void {
    _coordinator = undefined;
  }

  export function setResidentRuntime(manager: ResidentRuntime): void {
    _residentRuntime = manager;
  }

  export function clearResidentRuntime(): void {
    _residentRuntime = undefined;
  }

  export function setAgentResolver(resolver: AgentResolver): void {
    _agentResolver = resolver;
  }

  export function clearAgentResolver(): void {
    _agentResolver = undefined;
  }

  export function setDispatchRuntime(runtime: DispatchRuntime): void {
    _dispatchRuntime = runtime;
  }

  export function clearDispatchRuntime(): void {
    _dispatchRuntime = undefined;
  }

  export function setPolicyDecisionObserver(
    observer: ((decision: PolicyDecision) => void | Promise<void>) | undefined,
  ): void {
    _middlewareDecisionObserver = observer;
  }

  export function registerIngressPolicy(reg: PolicyRegistration): void {
    _ingressPolicies.push(reg);
  }

  export async function ingest(event: unknown): Promise<Ingress.IngressResult> {
    const externalEvent = IngressNamespace.DirectEventSchema.parse(event);
    const resolvedActorEvent = resolveIngressActor(externalEvent);
    if (resolvedActorEvent.mode !== "direct") {
      throw new TypeError("external ingress actor resolution changed event mode");
    }
    const trace = TraceContext.create();
    const route = resolveAndRecordRoute(resolvedActorEvent, trace.traceId);
    const decision = requireRoutedDecision(route.decision);
    const waitExecution = await executeWaitRoute(_dispatchRuntime, trace, route, decision);
    if (waitExecution.kind === "handled") return waitExecution.result;
    if (waitExecution.authority === "wait_precedence") {
      const inboundEvent = pinRouteSession(
        pinSelectedTarget(waitExecution.event, route.selectedTarget),
        decision,
      );
      return ingestResolved(inboundEvent, route.selectedTarget, trace, _coordinator);
    }

    const preRun = await IngressAuthorityMiddleware.runRoutedPreRun({
      event: waitExecution.event,
      coordinator: _coordinator,
      traceContext: trace,
      onDecision: _middlewareDecisionObserver,
    });

    const inboundEvent = pinRouteSession(
      pinSelectedTarget(preRun.event, route.selectedTarget),
      decision,
    );
    return ingestResolved(inboundEvent, route.selectedTarget, trace, preRun.coordinator);
  }

  export async function ingestInternal(
    event: Ingress.InternalEvent,
    runtime?: Readonly<{
      residentRuntime?: Pick<ResidentRuntime, "run">;
      agentResolver?: AgentResolver;
    }>,
  ): Promise<Ingress.IngressResult> {
    const trace = TraceContext.create();
    const route = resolveAndRecordRoute(event, trace.traceId);
    const decision = requireRoutedDecision(route.decision);
    const waitExecution = await executeWaitRoute(_dispatchRuntime, trace, route, decision);
    if (waitExecution.kind === "handled") return waitExecution.result;
    if (waitExecution.event.mode !== "internal") {
      throw new TypeError("internal ingress wait execution changed event mode");
    }
    const agentResolver = runtime?.agentResolver ?? _agentResolver;
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
      _coordinator,
      runtime?.residentRuntime ?? _residentRuntime,
    );
  }

  async function ingestResolved(
    inboundEvent: Ingress.ResolvedInboundEvent,
    target: Ingress.Target,
    trace: TraceContextProtocol.Type,
    coordinator: CoordinatorLike | undefined,
    residentRuntime: Pick<ResidentRuntime, "run"> | undefined = _residentRuntime,
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

    if (_ingressPolicies.length > 0) {
      const engine = PolicyEngine.create({
        traceContext: trace,
        onDecision: _middlewareDecisionObserver,
        auditEmit: Bus.publish,
      });
      for (const reg of _ingressPolicies) {
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
      policies: _ingressPolicies,
      onPolicyDecision: _middlewareDecisionObserver,
    };

    if (target.kind === "resident") {
      return IngressHandlers.handleResident(handlerContext);
    }

    return IngressHandlers.handleDirect(handlerContext);
  }
}

export const ingestInternal = IngressEngine.ingestInternal;
export const setAgentResolver = IngressEngine.setAgentResolver;
export const clearAgentResolver = IngressEngine.clearAgentResolver;
