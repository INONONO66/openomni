import type { PolicyDecision } from "@openomni/policy";
import type { PolicyRegistration } from "@openomni/agent";
import type { Ingress, TraceContext as TraceContextProtocol } from "@openomni/protocol";
import type { ResidentRuntime } from "../resident/runtime";
import type { CoordinatorLike } from "./coordinator-like";

export interface HandlerContext {
  sessionId: string;
  event: Ingress.ResolvedInboundEvent;
  coordinator?: CoordinatorLike;
  residentRuntime?: Pick<ResidentRuntime, "run">;
  traceContext?: TraceContextProtocol.Type;
  policies?: readonly PolicyRegistration[];
  onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
}
