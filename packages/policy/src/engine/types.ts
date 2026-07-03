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
  };

export type PolicyDecision = Policy.PolicyDecision;

export interface PolicyAuditConfig {
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

export interface PolicyRegistrationGeneric<TCtx extends GenericPolicyContext> {
  name: string;
  timing: Policy.Timing | Policy.Timing[];
  priority: number;
  scope?: Policy.Scope;
  failPolicy?: Policy.FailPolicy;
  fn(
    ctx: Readonly<AuditDispatchContextGeneric<TCtx>>,
  ): Promise<Policy.PolicyDecision> | Policy.PolicyDecision;
  propagate?: boolean;
}

export interface PolicyEngineInstanceGeneric<TCtx extends GenericPolicyContext> {
  register(reg: PolicyRegistrationGeneric<TCtx>): void;
  dispatch(
    timing: Policy.Timing,
    ctx: DispatchContextGeneric<TCtx> & Record<string, unknown>,
  ): Promise<Policy.PolicyDecision>;
}
