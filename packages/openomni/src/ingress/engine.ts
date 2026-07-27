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
import type { WorkerAttemptLifecycleService } from "./handler-worker-run";
import { resolveIngressActor } from "./actor-resolver";
import type { AuthorityProjectionQueryPort } from "./actor-resolver";
import { IngressEventProjector } from "./event-projector";
import { IngressHandlers } from "./handlers";
import { IngressAuthorityMiddleware } from "./middleware/ingress-authority";
import {
  configureMessagingLedgerService,
  type MessagingLedgerService,
  IngressSessionResolver,
} from "./session-resolver";
import {
  executeWaitRoute,
  pinRouteSession,
  pinSelectedTarget,
  requireRoutedDecision,
} from "./routing-execution";
import { resolveKernelRoute, type KernelRouteResolution } from "./routing-runtime";
import {
  applyWaitCorrelationEffect,
  createWaitKernelService,
  type WaitKernelQueryService,
  type WaitKernelService,
  type WaitKernelTransitionService,
} from "./wait-correlation";
import { targetKey } from "./target";

export type { CoordinatorLike };

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export interface AgentResolver {
  resolve(agentName: string, event: Ingress.InternalEvent): Promise<Ingress.AgentDef>;
}

export interface IngressKernelPorts {
  readonly authorityQueries: AuthorityProjectionQueryPort;
  readonly waitQueries: WaitKernelQueryService;
  readonly waitTransitions: WaitKernelTransitionService;
  readonly workerAttempts: WorkerAttemptLifecycleService;
}

let _coordinator: CoordinatorLike | undefined;
let _residentRuntime: ResidentRuntime | undefined;
let _middlewareDecisionObserver: ((decision: PolicyDecision) => void | Promise<void>) | undefined;
let _ingressPolicies: PolicyRegistration[] = [];
let _agentResolver: AgentResolver | undefined;
let _dispatchRuntime: DispatchRuntime | undefined;
let _kernelPorts: IngressKernelPorts | undefined;

function assertInboundReceiveAllowed(decision: Policy.PolicyDecision): void {
  if (!Decision.isBlocking(decision)) return;
  throw new Error(Decision.reason(decision, "inbound.receive policy denied"));
}

function requireKernelPorts(): Readonly<{
  authorityQueries: AuthorityProjectionQueryPort;
  waitKernel: WaitKernelService;
  workerAttempts: WorkerAttemptLifecycleService;
}> {
  if (_kernelPorts === undefined) throw new Error("ingress kernel ports not configured");
  return {
    authorityQueries: _kernelPorts.authorityQueries,
    waitKernel: createWaitKernelService(_kernelPorts.waitQueries, _kernelPorts.waitTransitions),
    workerAttempts: _kernelPorts.workerAttempts,
  };
}

export async function applySelectedWaitEffect(
  resolution: Pick<KernelRouteResolution, "decision" | "waitEffect">,
  waitKernel: WaitKernelService,
  transportId: string,
): Promise<void> {
  const selected =
    resolution.decision.stage === "wait_correlation" && resolution.decision.outcome === "ambiguous";
  if (!selected && resolution.waitEffect.kind !== "none") {
    throw new TypeError("non-wait-ambiguous decision carried an executable wait effect");
  }
  if (selected) await applyWaitCorrelationEffect(waitKernel, resolution.waitEffect, transportId);
}

async function resolvePublishAndApplyWaitEffect<Event extends Ingress.InboundEvent>(
  event: Event,
  traceId: string,
  authorityQueries: AuthorityProjectionQueryPort,
  waitKernel: WaitKernelService,
): Promise<KernelRouteResolution<Event>> {
  const resolution = await resolveKernelRoute(event, traceId, {
    authorityQueries,
    waits: waitKernel,
  });
  const decision = IngressEvent.RoutingDecision.schema.parse(resolution.decision);
  const validated = { ...resolution, decision };
  Bus.publish(IngressEvent.RoutingDecision, decision);

  await applySelectedWaitEffect(validated, waitKernel, event.id);
  return validated;
}

export namespace IngressEngine {
  export function reset(): void {
    Bus.reset();
    configureMessagingLedgerService(undefined);
    _coordinator = undefined;
    _residentRuntime = undefined;
    _middlewareDecisionObserver = undefined;
    _ingressPolicies = [];
    _agentResolver = undefined;
    _dispatchRuntime = undefined;
    _kernelPorts = undefined;
  }

  export function setKernelPorts(ports: IngressKernelPorts): void {
    _kernelPorts = ports;
  }

  export function clearKernelPorts(): void {
    _kernelPorts = undefined;
  }

  export function setMessagingLedgerService(service: MessagingLedgerService): void {
    configureMessagingLedgerService(service);
  }

  export function clearMessagingLedgerService(): void {
    configureMessagingLedgerService(undefined);
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
    const ports = requireKernelPorts();
    const externalEvent = IngressNamespace.DirectEventSchema.parse(event);
    const resolvedActorEvent = await resolveIngressActor(externalEvent, ports.authorityQueries);
    if (resolvedActorEvent.mode !== "direct") {
      throw new TypeError("external ingress actor resolution changed event mode");
    }
    const trace = TraceContext.create();
    const route = await resolvePublishAndApplyWaitEffect(
      resolvedActorEvent,
      trace.traceId,
      ports.authorityQueries,
      ports.waitKernel,
    );
    const decision = requireRoutedDecision(route.decision);
    const waitExecution = await executeWaitRoute(_dispatchRuntime, trace, route, decision);
    if (waitExecution.kind === "handled") return waitExecution.result;
    if (waitExecution.authority === "wait_precedence") {
      const inboundEvent = pinRouteSession(
        pinSelectedTarget(waitExecution.event, route.selectedTarget),
        decision,
      );
      return ingestResolved(inboundEvent, route.selectedTarget, trace, _coordinator, ports);
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
    return ingestResolved(inboundEvent, route.selectedTarget, trace, preRun.coordinator, ports);
  }

  export async function ingestInternal(
    event: Ingress.InternalEvent,
    runtime?: Readonly<{
      residentRuntime?: Pick<ResidentRuntime, "run">;
      agentResolver?: AgentResolver;
    }>,
  ): Promise<Ingress.IngressResult> {
    const ports = requireKernelPorts();
    const trace = TraceContext.create();
    const route = await resolvePublishAndApplyWaitEffect(
      event,
      trace.traceId,
      ports.authorityQueries,
      ports.waitKernel,
    );
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
      ports,
      runtime?.residentRuntime ?? _residentRuntime,
    );
  }

  async function ingestResolved(
    inboundEvent: Ingress.ResolvedInboundEvent,
    target: Ingress.Target,
    trace: TraceContextProtocol.Type,
    coordinator: CoordinatorLike | undefined,
    ports: Readonly<{ workerAttempts: WorkerAttemptLifecycleService }>,
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

    const model = {
      providerID: inboundEvent.agent.model.provider,
      modelID: inboundEvent.agent.model.id,
    };

    if (target.kind === "resident") {
      const receipt = await IngressEventProjector.projectResident(
        inboundEvent,
        IngressSessionResolver.extractSurfaceKey(inboundEvent),
        model,
        trace,
      );
      Bus.publish(IngressEvent.SessionResolved, {
        traceId: trace.traceId,
        sessionId: receipt.sessionId,
        isNew: receipt.isNewSession,
        target: "resident",
        time: Date.now(),
      });
      if (receipt.outcome !== undefined) {
        if (receipt.outcome.status === "confirmed") return receipt.outcome.result;
        throw new Error(`resident effect ${receipt.outcome.status}: ${receipt.outcome.error}`);
      }

      const activeTrace = TraceContext.child(trace, { sessionId: receipt.sessionId });
      const handlerContext = {
        sessionId: receipt.sessionId,
        event: inboundEvent,
        coordinator,
        residentRuntime,
        traceContext: activeTrace,
        policies: _ingressPolicies,
        onPolicyDecision: _middlewareDecisionObserver,
        workerAttempts: ports.workerAttempts,
      };

      if (!residentRuntime) {
        const error = "resident runtime is required";
        await IngressEventProjector.settleResident(receipt, inboundEvent.id, {
          status: "definite_failed",
          error,
        });
        throw new Error(error);
      }

      try {
        const result = await IngressHandlers.handleResident(handlerContext);
        await IngressEventProjector.settleResident(receipt, inboundEvent.id, {
          status: "confirmed",
          result,
        });
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await IngressEventProjector.settleResident(receipt, inboundEvent.id, {
          status: "unknown",
          error: detail,
        });
        throw error;
      }
    }

    const { session } = await IngressSessionResolver.resolve(inboundEvent, model, trace);
    const activeAttempts = await ports.workerAttempts.queries.active({
      sessionId: session.id,
      ...(inboundEvent.runtime?.runId ? { runId: inboundEvent.runtime.runId } : {}),
    });
    if (activeAttempts.length !== 1) {
      throw new Error("worker ingress requires exactly one authoritative active Attempt binding");
    }

    const activeTrace = TraceContext.child(trace, { sessionId: session.id });
    await IngressEventProjector.project(inboundEvent, session.id, model, activeTrace);
    return IngressHandlers.handleDirect({
      sessionId: session.id,
      event: inboundEvent,
      coordinator,
      residentRuntime,
      traceContext: activeTrace,
      policies: _ingressPolicies,
      onPolicyDecision: _middlewareDecisionObserver,
      workerAttempts: ports.workerAttempts,
    });
  }
}

export const ingestInternal = IngressEngine.ingestInternal;
export const setAgentResolver = IngressEngine.setAgentResolver;
export const clearAgentResolver = IngressEngine.clearAgentResolver;
