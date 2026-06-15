import type { PolicyDecision, PolicyRegistration } from "@openomni/agent";
import type { Ingress, TraceContext as TraceContextProtocol } from "@openomni/protocol";
import type { ResidentRuntime } from "../resident/runtime";
import type { CoordinatorLike } from "./coordinator-like";

export interface HandlerContext {
  sessionId: string;
  event: Ingress.ResolvedInboundEvent;
  coordinator?: CoordinatorLike;
  residentRuntime?: ResidentRuntime;
  traceContext?: TraceContextProtocol.Type;
  policies?: PolicyRegistration[];
  onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
}
