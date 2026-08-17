import type { BusEvent, Message, Policy, RuntimeResource, TraceContext } from "@openomni/protocol";

export type PolicyPointId = keyof typeof Policy.PolicyPoint.Registry;

export interface GenericPolicyContext {
  agentType?: string;
  resourceDescriptor?: RuntimeResource.Descriptor;
  traceContext?: TraceContext.Type;
  toolName?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolLabels?: string[];
  toolOutput?: string;
  labels?: Policy.LabelEntry[];
  messages?: Message.WithParts[];
  usage?: unknown;
}

export type DispatchContextGeneric<TCtx extends GenericPolicyContext> = Omit<TCtx, "timing"> & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

export type AuditDispatchContextGeneric<TCtx extends GenericPolicyContext> =
  DispatchContextGeneric<TCtx> & {
    readonly timing: Policy.Timing;
    readonly pointId?: PolicyPointId;
  };

export type CanonicalAuditDispatchContextGeneric<TCtx extends GenericPolicyContext> =
  AuditDispatchContextGeneric<TCtx> & {
    readonly pointId: PolicyPointId;
  };

export type DispatchPointContextGeneric<
  TCtx extends GenericPolicyContext,
  TPointId extends PolicyPointId,
> = DispatchContextGeneric<TCtx> & Policy.PolicyPointInputMap[TPointId] & Record<string, unknown>;

export type PolicyDecision = Policy.PolicyDecision;

export type AuditEmit = <T>(event: BusEvent.Descriptor<T>, data: T) => void;

export interface PolicyEngineConfig {
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
  readonly traceContext?: TraceContext.Type;
  /**
   * `false` disables audit emission entirely. The former object form
   * (sessionId/actor/action/resource override lanes) was dead config: no
   * production or test caller ever constructed it, so every audit record was
   * already derived from the trace context (#606 re-audit).
   */
  readonly audit?: false;
  readonly auditEmit?: AuditEmit;
}

export interface CanonicalPolicyRegistrationGeneric<TCtx extends GenericPolicyContext> {
  readonly kind: "point";
  readonly name: string;
  readonly pointIds: readonly PolicyPointId[];
  readonly effectCapabilities: Readonly<
    Partial<Record<PolicyPointId, readonly Policy.PolicyEffectType[]>>
  >;
  readonly priority: number;
  readonly scope?: Policy.Scope;
  readonly failPolicy?: Policy.FailPolicy;
  readonly fn: (
    ctx: Readonly<CanonicalAuditDispatchContextGeneric<TCtx>>,
  ) => Promise<Policy.PolicyDecision> | Policy.PolicyDecision;
}

/**
 * A per-engine registration factory: `create()` is invoked by the engine at
 * `register()` time, once per engine. Engines are built once per agent run,
 * so any mutable state the returned registration closes over is run-scoped.
 *
 * This is the only sound home for stateful policies (budget nudges, idle
 * tracking): dispatch contexts are structured-clone frozen, so state cannot
 * ride on them, and a plain registration instance shared through a middleware
 * array leaks its closures across runs and across parent/child agents.
 */
export interface PolicyRegistrationFactoryGeneric<TCtx extends GenericPolicyContext> {
  readonly kind: "factory";
  readonly name: string;
  readonly create: () => CanonicalPolicyRegistrationGeneric<TCtx>;
}

/** What an engine accepts: a stateless registration, or a per-engine factory. */
export type PolicyEngineMiddlewareGeneric<TCtx extends GenericPolicyContext> =
  | CanonicalPolicyRegistrationGeneric<TCtx>
  | PolicyRegistrationFactoryGeneric<TCtx>;

export interface PolicyEngineInstanceGeneric<TCtx extends GenericPolicyContext> {
  register(reg: PolicyEngineMiddlewareGeneric<TCtx>): void;
  dispatchPoint<TPointId extends PolicyPointId>(
    pointId: TPointId,
    ctx: DispatchPointContextGeneric<TCtx, TPointId>,
  ): Promise<Policy.PolicyDecision>;
}
