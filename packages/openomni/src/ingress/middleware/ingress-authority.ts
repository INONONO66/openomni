import { PolicyEngine } from "@openomni/policy";
import type { PolicyRegistration } from "@openomni/agent";
import { PolicyDecision } from "@openomni/protocol";
import { resolveTarget } from "../target";
import type { AuthorityProjectionQueryPort } from "../actor-resolver";
import { targetRequiresCoordinator } from "./ingress-authority-actor";
import { throwAbort } from "./ingress-authority-decisions";
import { IngressAuthorityDefinitions } from "./ingress-authority-definitions";
import {
  registrations as createRegistrations,
  routedRegistrations as createRoutedRegistrations,
} from "./ingress-authority-registrations";
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

  export function registrations(
    state: PreRunState,
    queries: AuthorityProjectionQueryPort,
  ): PolicyRegistration[] {
    return createRegistrations(state, queries);
  }

  export async function runPreRun(
    ctx: PreRunContext,
    queries: AuthorityProjectionQueryPort,
  ): Promise<PreRunResult> {
    return run(ctx, (state) => createRegistrations(state, queries));
  }

  export async function runRoutedPreRun(ctx: PreRunContext): Promise<PreRunResult> {
    return run(ctx, createRoutedRegistrations);
  }

  async function run(
    ctx: PreRunContext,
    create: (state: PreRunState) => PolicyRegistration[],
  ): Promise<PreRunResult> {
    const state: PreRunState = { input: ctx.event, coordinator: ctx.coordinator };
    const engine = PolicyEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
    });

    for (const registration of create(state)) {
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
