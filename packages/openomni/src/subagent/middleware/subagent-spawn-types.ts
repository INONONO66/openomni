import type { PolicyRegistration } from "@openomni/agent";
import type { Policy, RuntimeResource, TraceContext } from "@openomni/protocol";
import type { Session, WorkerRunRecord } from "@openomni/session";

type SessionRecord = NonNullable<ReturnType<typeof Session.get>>;

export type PreSpawnOperation = "send" | "resume" | "cancel" | "wait";

export interface PreSpawnState {
  readonly operation: PreSpawnOperation;
  readonly sessionId: string;
  readonly hardTimeoutMs?: number;
  readonly timeoutMs?: number;
  session?: SessionRecord;
  runs?: WorkerRunRecord[];
  latestRun?: WorkerRunRecord;
  cancelHardTimeoutMs?: number;
  waitTimeoutMs?: number;
}

export interface PreSpawnContext {
  readonly operation: PreSpawnOperation;
  readonly sessionId: string;
  readonly hardTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly traceContext?: TraceContext.Type;
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
}

export interface PreSpawnResult {
  readonly verdict: Policy.PolicyDecision;
  readonly session?: SessionRecord;
  readonly runs?: WorkerRunRecord[];
  readonly latestRun?: WorkerRunRecord;
  readonly cancelHardTimeoutMs: number;
  readonly waitTimeoutMs?: number;
}

export interface WaitTimeoutHandle {
  readonly cancel: () => void;
}

export interface ChildRuntimeMiddlewareInput {
  readonly middleware?: PolicyRegistration[];
  readonly hasExplicitRuntimePolicy: boolean;
}

export type PreSpawnPolicyContext = Parameters<
  ReturnType<typeof import("@openomni/agent").PolicyEngine.create>["dispatch"]
>[1] & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};
