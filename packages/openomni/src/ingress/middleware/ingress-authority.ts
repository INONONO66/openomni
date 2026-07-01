import { PolicyEngine } from "@openomni/policy";
import type { PolicyRegistration } from "@openomni/agent";
import { PolicyDecision } from "@openomni/protocol";
import { resolveTarget } from "../target";
import { targetRequiresCoordinator } from "./ingress-authority-actor";
import { throwAbort } from "./ingress-authority-decisions";
import { IngressAuthorityDefinitions } from "./ingress-authority-definitions";
import { registrations as createRegistrations } from "./ingress-authority-registrations";
import {
  emptyUsage,
  type PreRunContext,
  type PreRunResult,
  type PreRunState,
} from "./ingress-authority-types";

export namespace IngressAuthorityMiddleware {
  export const CoordinatorPresence = IngressAuthorityDefinitions.CoordinatorPresence;
  export const SchemaValidation = IngressAuthorityDefinitions.SchemaValidation;
  export const BlacklistCheck = IngressAuthorityDefinitions.BlacklistCheck;
  export const ChannelGrantCheck = IngressAuthorityDefinitions.ChannelGrantCheck;
  export const AuthorityCheck = IngressAuthorityDefinitions.AuthorityCheck;
  export const ModeDispatch = IngressAuthorityDefinitions.ModeDispatch;

  export function registrations(state: PreRunState): PolicyRegistration[] {
    return createRegistrations(state);
  }

  export async function runPreRun(ctx: PreRunContext): Promise<PreRunResult> {
    const state: PreRunState = { input: ctx.event, coordinator: ctx.coordinator };
    const engine = PolicyEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
    });

    for (const registration of registrations(state)) {
      engine.register(registration);
    }

    const decision = await engine.dispatch("run.start", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolInput: { event: ctx.event },
      traceContext: ctx.traceContext,
    });

    if (PolicyDecision.isBlocking(decision)) throwAbort(decision, state);
    if (!state.parsedEvent || !state.mode) {
      throw new Error("ingress run.start middleware did not produce dispatch context");
    }
    const target = state.target ?? resolveTarget(state.parsedEvent);
    if (targetRequiresCoordinator(target) && !state.coordinator) {
      throw new Error("ingress run.start middleware did not produce coordinator for worker target");
    }

    return {
      event: state.parsedEvent,
      coordinator: state.coordinator,
      mode: state.mode,
      target,
    };
  }
}
