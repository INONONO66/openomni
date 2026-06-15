import type { Policy, RuntimeResource, TraceContext } from "@openomni/protocol";
import type { PolicyContext, PolicyRegistration } from "./types";

type AuditVisibility = "internal" | "llm_reason" | "user_audit";
export type PolicyPointId = keyof typeof Policy.PolicyPoint.Registry;

export type AuditDispatchContext = PolicyContext & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

export type DispatchContext = Omit<PolicyContext, "timing"> & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
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

export interface PolicyEngineConfig {
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
  readonly traceContext?: TraceContext.Type;
  readonly audit?: PolicyAuditConfig | false;
}

export interface PolicyEngineInstance {
  register(reg: PolicyRegistration): void;
  dispatch(timing: Policy.Timing, ctx: DispatchContext): Promise<Policy.PolicyDecision>;
}
