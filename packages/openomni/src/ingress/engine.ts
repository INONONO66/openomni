import { PolicyEngine, type PolicyDecision, type PolicyRegistration } from "@openomni/agent";
import { type Ingress, type Policy, IngressEvent } from "@openomni/protocol";
import { Bus, Storage, SurfaceKey, TraceContext } from "@openomni/session";
import type { CoordinatorLike } from "./coordinator-like";
import { IngressEventProjector } from "./event-projector";
import { IngressHandlers } from "./handlers";
import { IngressAuthorityMiddleware } from "./middleware/ingress-authority";
import { IngressSessionResolver } from "./session-resolver";

export type { CoordinatorLike };

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

let _coordinator: CoordinatorLike | undefined;
let _middlewareDecisionObserver: ((decision: PolicyDecision) => void | Promise<void>) | undefined;
let _ingressPolicies: PolicyRegistration[] = [];

function assertInboundReceiveAllowed(verdict: Policy.Verdict): void {
  switch (verdict.action) {
    case "continue":
      return;
    case "skip":
    case "abort":
    case "retry":
    case "transform":
    case "inject":
    case "deny":
      throw new Error(verdict.reason ?? `inbound.receive policy returned ${verdict.action}`);
  }
}

export namespace IngressEngine {
  export function reset(): void {
    SurfaceKey.clear();
    Storage.reset();
    Bus.reset();
    _coordinator = undefined;
    _middlewareDecisionObserver = undefined;
    _ingressPolicies = [];
  }

  export function setCoordinator(c: CoordinatorLike): void {
    _coordinator = c;
  }

  export function clearCoordinator(): void {
    _coordinator = undefined;
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

    const payloadLength =
      typeof inboundEvent.payload === "string"
        ? inboundEvent.payload.length
        : (JSON.stringify(inboundEvent.payload ?? null) ?? "").length;

    Bus.publish(IngressEvent.Received, {
      traceId: trace.traceId,
      surface: inboundEvent.surface,
      mode: inboundEvent.mode,
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
      ];
      const actor = inboundEvent.meta?.actor;
      if (actor && typeof actor === "object" && !Array.isArray(actor)) {
        const role = String((actor as Record<string, unknown>).role ?? "");
        if (role) labels.push({ value: `actor.${role}`, source: "system" });
      }

      const verdict = await engine.dispatch("inbound.receive", {
        steps: [],
        usage: emptyUsage,
        turnCount: 0,
        isCompletion: false,
        continuationCount: 0,
        elapsedMs: 0,
        labels,
        toolInput: { surface: inboundEvent.surface, mode: inboundEvent.mode },
        traceContext: trace,
      });

      assertInboundReceiveAllowed(verdict);
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

    return IngressHandlers.handleDirect({
      sessionId: session.id,
      event: inboundEvent,
      coordinator: preRun.coordinator,
      traceContext: activeTrace,
      policies: _ingressPolicies,
      onPolicyDecision: _middlewareDecisionObserver,
    });
  }
}
