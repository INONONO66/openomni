import type { BusEvent, Message, Policy, RuntimeResource, TraceContext } from "@openomni/protocol";

type AuditVisibility = "internal" | "llm_reason" | "user_audit";
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

interface PolicyAuditConfig {
  readonly sessionId?: string;
  readonly actor?: Record<string, unknown>;
  readonly action?: string;
  readonly resource?: string;
  readonly visibility?: AuditVisibility;
  readonly parentActionId?: string;
}

export type AuditEmit = <T>(event: BusEvent.Descriptor<T>, data: T) => void;

export interface PolicyEngineConfig {
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
  readonly traceContext?: TraceContext.Type;
  readonly audit?: PolicyAuditConfig | false;
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
  readonly propagate?: boolean;
}

/**
 * Canonical-only since #530: the legacy timing-based registration shape and
 * the legacy `dispatch(timing)` entry point are gone; `register()` rejects
 * timing shapes fail-closed at the trusted boundary.
 */
export type PolicyEngineRegistrationGeneric<TCtx extends GenericPolicyContext> =
  CanonicalPolicyRegistrationGeneric<TCtx>;

export interface PolicyEngineInstanceGeneric<TCtx extends GenericPolicyContext> {
  register(reg: CanonicalPolicyRegistrationGeneric<TCtx>): void;
  dispatchPoint<TPointId extends PolicyPointId>(
    pointId: TPointId,
    ctx: DispatchPointContextGeneric<TCtx, TPointId>,
  ): Promise<Policy.PolicyDecision>;
}
