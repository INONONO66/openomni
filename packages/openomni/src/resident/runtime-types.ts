import type { ChatAgentConfig, ChatAgentInput } from "@openomni/agent";
import type { Ingress, TraceContext as TraceContextProtocol } from "@openomni/protocol";

export type ResidentLifecycle = "sleeping" | "hydrating" | "active" | "idle" | "releasing";

export interface ResidentRunContext {
  readonly sessionId: string;
  readonly event: Ingress.ResolvedInboundEvent;
  readonly traceContext?: TraceContextProtocol.Type;
  readonly signal?: AbortSignal;
}

export interface ResidentRunResult {
  readonly output: string;
  readonly finishReason: string;
  readonly runId: string;
  readonly activationId: string;
}

export interface ResidentRuntimeOptions {
  readonly maxActive?: number;
  readonly idleTimeoutMs?: number;
  readonly slotWaitTimeoutMs?: number;
  readonly runAgent?: (
    config: ChatAgentConfig,
    input: ChatAgentInput,
  ) => Promise<{
    text: string;
    finishReason: string;
  }>;
}

export interface ActivationRecord {
  activationId: string;
  lifecycle: ResidentLifecycle;
  idleTimer?: ReturnType<typeof setTimeout>;
  queue: Promise<unknown>;
  lastUsedAt: number;
}

export type SlotWaiter = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};
