import { type Policy, PolicyDecision } from "@openomni/protocol";
import {
  COMPOSED_POLICY_ID,
  composeFinalDecision,
  middlewareErrorDecision,
  normalizeDecision,
} from "./decisions";
import { defaultFailPolicy } from "./points";
import { immutableSnapshot } from "./context";
import { publishComposedDecision } from "./audit";
import { publishMiddlewareDebug, publishMiddlewareError, recordDecision } from "./telemetry";
import type {
  DispatchContextGeneric,
  GenericPolicyContext,
  PolicyEngineConfig,
  PolicyEngineInstanceGeneric,
  PolicyRegistrationGeneric,
} from "./types";

export function createPolicyEngine<TCtx extends GenericPolicyContext>(
  options: PolicyEngineConfig = {},
): PolicyEngineInstanceGeneric<TCtx> {
  const registrations: PolicyRegistrationGeneric<TCtx>[] = [];

  async function dispatch(
    timing: Policy.Timing,
    ctx: DispatchContextGeneric<TCtx> & Record<string, unknown>,
  ): Promise<Policy.PolicyDecision> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx = immutableSnapshot({
      ...ctx,
      timing,
    });
    const decisions: Policy.PolicyDecision[] = [];

    function composeAndPublish(): Policy.PolicyDecision {
      const decision = composeFinalDecision(decisions, timing, ctx.resourceDescriptor);
      publishComposedDecision(options, timing, fullCtx, decision);
      return decision;
    }

    if (selected.length === 0) {
      const decision = PolicyDecision.allow({ policyId: COMPOSED_POLICY_ID });
      publishComposedDecision(options, timing, fullCtx, decision);
      return decision;
    }

    for (const reg of selected) {
      let decision: Policy.PolicyDecision;
      const startTime = Date.now();
      try {
        decision = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? defaultFailPolicy(timing, ctx.resourceDescriptor);
        publishMiddlewareError(options, timing, reg.name, err, failPolicy, durationMs);
        if (failPolicy === "fail-open") continue;

        decision = middlewareErrorDecision(reg, durationMs, timing, ctx.resourceDescriptor);
      }

      const durationMs = Date.now() - startTime;
      const normalized = normalizeDecision(
        decision,
        reg,
        durationMs,
        timing,
        ctx.resourceDescriptor,
      );
      decisions.push(recordDecision(options, reg, fullCtx, normalized));
      publishMiddlewareDebug(options, timing, reg.name, normalized.verdict, durationMs);

      if (normalized.verdict === "deny") return composeAndPublish();
    }

    return composeAndPublish();
  }

  return {
    register(reg) {
      registrations.push(reg);
    },
    dispatch,
  };
}

// merged from selection.ts (#453 hygiene: sub-30-LOC single-importer)
function matchesTiming<TCtx extends GenericPolicyContext>(
  reg: PolicyRegistrationGeneric<TCtx>,
  timing: Policy.Timing,
): boolean {
  return Array.isArray(reg.timing) ? reg.timing.includes(timing) : reg.timing === timing;
}

function matchesScope<TCtx extends GenericPolicyContext>(
  reg: PolicyRegistrationGeneric<TCtx>,
  agentType: string | undefined,
): boolean {
  const allowed = reg.scope?.agentType;
  if (!allowed || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

export function selectRegistrations<TCtx extends GenericPolicyContext>(
  registrations: readonly PolicyRegistrationGeneric<TCtx>[],
  timing: Policy.Timing,
  agentType: string | undefined,
): PolicyRegistrationGeneric<TCtx>[] {
  return registrations
    .map((reg, index) => ({ index, reg }))
    .filter(({ reg }) => matchesTiming(reg, timing) && matchesScope(reg, agentType))
    .sort((a, b) => a.reg.priority - b.reg.priority || a.index - b.index)
    .map(({ reg }) => reg);
}
