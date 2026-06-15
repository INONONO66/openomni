import type { Policy } from "@openomni/protocol";
import type { ZodError } from "zod";
import type { CoordinatorLike } from "../coordinator-like";
import type { Ingress, TraceContext } from "@openomni/protocol";

export const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export type ActorRecord = Record<string, unknown>;

export interface PreRunState {
  readonly input: unknown;
  readonly coordinator?: CoordinatorLike;
  parsedEvent?: Ingress.InboundEvent;
  schemaError?: ZodError;
  mode?: Ingress.InboundEvent["mode"];
  target?: Ingress.Target;
}

export interface PreRunContext {
  readonly event: unknown;
  readonly coordinator?: CoordinatorLike;
  readonly traceContext?: TraceContext.Type;
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
}

export interface PreRunResult {
  readonly event: Ingress.InboundEvent;
  readonly coordinator?: CoordinatorLike;
  readonly mode: Ingress.InboundEvent["mode"];
  readonly target: Ingress.Target;
}
