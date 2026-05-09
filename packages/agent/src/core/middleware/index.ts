/**
 * @deprecated Import from `../policy` instead.
 * This barrel re-exports policy types under their legacy Middleware* names
 * so external consumers (openomni, server) keep compiling.
 */
import type { Hook, TraceContext } from "@openomni/protocol";
import { PolicyEngine, type PolicyAuditConfig, type PolicyDecision } from "../policy/engine";
import type {
  PolicyContext,
  PolicyEngineInstance,
  PolicyFn,
  PolicyRegistration,
  PolicySystemPromptVerdict,
  PolicyVerdict,
} from "../policy/types";

export type MiddlewareContext = PolicyContext;
export type MiddlewareFn = PolicyFn;
export type MiddlewareRegistration = PolicyRegistration;

export interface MiddlewareDecision {
  readonly timing: Hook.Timing;
  readonly name: string;
  readonly policyId: string;
  readonly verdict: Hook.Verdict["action"];
  readonly reason?: string;
  readonly durationMs: number;
  readonly traceContext?: TraceContext.Type;
  readonly envelope?: PolicyContext["envelope"];
}

export type MiddlewareEventLogConfig = PolicyAuditConfig;

export interface MiddlewareEngineConfig {
  readonly onDecision?: (decision: MiddlewareDecision) => void | Promise<void>;
  readonly traceContext?: TraceContext.Type;
  readonly eventLog?: MiddlewareEventLogConfig | false;
}

export interface MiddlewareEngineInstance {
  register(reg: PolicyRegistration): void;
  dispatch(timing: Hook.Timing, ctx: Omit<PolicyContext, "timing">): Promise<Hook.Verdict>;
  dispatchSystemPrompt(ctx: Omit<PolicyContext, "timing">): Promise<PolicySystemPromptVerdict>;
}

function toMiddlewareDecision(d: PolicyDecision): MiddlewareDecision {
  return {
    timing: d.timing as Hook.Timing,
    name: d.label,
    policyId: d.policyId,
    verdict: (d.verdict.action === "deny" ? "abort" : d.verdict.action) as Hook.Verdict["action"],
    durationMs: d.durationMs,
    ...(d.reason !== undefined && { reason: d.reason }),
    ...(d.traceContext !== undefined && { traceContext: d.traceContext }),
    ...(d.envelope !== undefined && { envelope: d.envelope }),
  };
}

function create(options: MiddlewareEngineConfig = {}): MiddlewareEngineInstance {
  const audit = options.eventLog === false ? false : (options.eventLog ?? undefined);

  const onDecision = options.onDecision
    ? (d: PolicyDecision) => options.onDecision!(toMiddlewareDecision(d))
    : undefined;

  const engine: PolicyEngineInstance = PolicyEngine.create({
    onDecision,
    traceContext: options.traceContext,
    audit,
  });

  return {
    register(reg) {
      engine.register(reg);
    },
    async dispatch(timing, ctx) {
      const verdict = await engine.dispatch(timing, ctx);
      if (verdict.action === "deny") {
        return { action: "abort", reason: verdict.reason, policyId: verdict.policyId };
      }
      return verdict as Hook.Verdict;
    },
    dispatchSystemPrompt(ctx) {
      return engine.dispatchSystemPrompt(ctx);
    },
  };
}

export const MiddlewareEngine = { create };
