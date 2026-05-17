import { PolicyEngine, type PolicyDecision, type PolicyRegistration } from "@openomni/agent";
import { Ingress, type Policy, IngressEvent, PolicyDecision as Decision } from "@openomni/protocol";
import { Bus, Storage, SurfaceKey, TraceContext } from "@openomni/session";
import type { CoordinatorLike } from "./coordinator-like";
import type { ResidentRuntime } from "../resident/runtime";
import { IngressEventProjector } from "./event-projector";
import { IngressHandlers } from "./handlers";
import { IngressAuthorityMiddleware } from "./middleware/ingress-authority";
import { IngressSessionResolver } from "./session-resolver";

export type { CoordinatorLike };

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

let _coordinator: CoordinatorLike | undefined;
let _residentRuntime: ResidentRuntime | undefined;
let _middlewareDecisionObserver: ((decision: PolicyDecision) => void | Promise<void>) | undefined;
let _ingressPolicies: PolicyRegistration[] = [];

function assertInboundReceiveAllowed(decision: Policy.PolicyDecision): void {
  if (!Decision.isBlocking(decision)) return;
  throw new Error(Decision.reason(decision, "inbound.receive policy denied"));
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

  export function setPolicyDecisionObserver(
    observer: ((decision: PolicyDecision) => void | Promise<void>) | undefined,
  ): void {
    _middlewareDecisionObserver = observer;
  }

  export function registerIngressPolicy(reg: PolicyRegistration): void {
    _ingressPolicies.push(reg);
  }

  export async function ingest(event: Ingress.InboundEvent): Promise<Ingress.IngressResult> {
    const trace = TraceContext.create();
    const preRun = await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: _coordinator,
      traceContext: trace,
      onDecision: _middlewareDecisionObserver,
    });

    const inboundEvent = preRun.event;
    const target = preRun.target;
    const targetLabel = Ingress.targetKey(target);

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
      });
      for (const reg of _ingressPolicies) {
        engine.register(reg);
      }

      const labels: Policy.LabelEntry[] = [
        { value: `surface.${inboundEvent.surface}`, source: "system" },
        { value: `target.${target.kind}`, source: "system" },
      ];
      const actor = inboundEvent.meta?.actor;
      if (actor && typeof actor === "object" && !Array.isArray(actor)) {
        const role = String((actor as Record<string, unknown>).role ?? "");
        if (role) labels.push({ value: `actor.${role}`, source: "system" });
      }

      const decision = await engine.dispatch("inbound.receive", {
        steps: [],
        usage: emptyUsage,
        turnCount: 0,
        isCompletion: false,
        continuationCount: 0,
        elapsedMs: 0,
        labels,
        toolInput: {
          surface: inboundEvent.surface,
          mode: inboundEvent.mode,
          target: target.kind,
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
      coordinator: preRun.coordinator,
      residentRuntime: _residentRuntime,
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
