import type {
  AgentResult,
  ChatAgentConfig,
  ChatAgentInput,
  ChatAgentInstance,
} from "@openomni/agent";
import type { CanonicalPolicyRegistrationGeneric, GenericPolicyContext } from "@openomni/policy";
import type { Model, Policy, ToolSelection, TraceContext } from "@openomni/protocol";
import type { InjectionQueue } from "../injection-queue.js";
import type { NativeTool } from "../tool/types.js";

type ChildStatus = "running" | "completed" | "failed" | "cancelled";

export const DEFAULT_MAX_CHILDREN = 4;
export const DEFAULT_AWAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 4_000;

type DelegationPolicyPointId = Extract<
  keyof typeof Policy.PolicyPoint.Registry,
  `delegation.worker.${string}`
>;

export type ChildWorkerProfile = {
  readonly name: "child_agent";
  readonly model: Model.Ref;
  readonly prompt: string;
};

export type ChildWorkerResult =
  | { readonly status: "completed"; readonly result: AgentResult }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled"; readonly reason: string };

export interface DelegationPolicyContext extends GenericPolicyContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly workerRunId?: string;
  readonly workerProfile?: ChildWorkerProfile;
  readonly workerResult?: ChildWorkerResult;
}

export type DelegationPolicyRegistration = Omit<
  CanonicalPolicyRegistrationGeneric<DelegationPolicyContext>,
  "pointIds" | "effectCapabilities"
> & {
  readonly pointIds: readonly DelegationPolicyPointId[];
  readonly effectCapabilities: Readonly<
    Partial<Record<DelegationPolicyPointId, readonly Policy.PolicyEffectType[]>>
  >;
};

export type ChildAgentSnapshot = {
  readonly id: string;
  readonly status: ChildStatus;
  readonly prompt: string;
  readonly output?: string;
  readonly error?: string;
  readonly finishReason?: AgentResult["finishReason"];
};

export type ChildAgentRuntimeOptions = {
  readonly model: Model.Ref;
  readonly systemPrompt?: string;
  readonly parentMessages: ChatAgentInput["messages"];
  readonly parentTools: readonly NativeTool[] | (() => readonly NativeTool[]);
  readonly injectionQueue?: InjectionQueue.Instance;
  readonly workspaceRoot?: string;
  readonly traceContext?: TraceContext.Type;
  readonly parentSignal?: AbortSignal;
  readonly maxChildren?: number;
  readonly awaitTimeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly auth?: ChatAgentConfig["auth"];
  readonly allowAuthFallback?: ChatAgentConfig["allowAuthFallback"];
  readonly budget?: ChatAgentConfig["budget"];
  readonly providerOptions?: ChatAgentConfig["providerOptions"];
  readonly middleware?: ChatAgentConfig["middleware"];
  readonly delegationPolicies?: readonly DelegationPolicyRegistration[];
  readonly createAgent: (config: ChatAgentConfig) => Pick<ChatAgentInstance, "run">;
};

export type ChildAgentSpawnInput = {
  readonly prompt: string;
  readonly tools?: ToolSelection.Selection;
  readonly notifyOnComplete?: boolean;
};

export type ChildRecord = {
  readonly id: string;
  readonly prompt: string;
  readonly controller: AbortController;
  status: ChildStatus;
  readonly maxOutputChars: number;
  readonly notifyOnComplete: boolean;
  result?: AgentResult;
  error?: string;
  completion: Promise<void>;
};

export type ChildAgentRuntime = {
  readonly spawn: (input: ChildAgentSpawnInput) => Promise<ChildAgentSnapshot>;
  readonly inspect: (ids?: readonly string[]) => readonly ChildAgentSnapshot[];
  readonly await: (ids?: readonly string[]) => Promise<readonly ChildAgentSnapshot[]>;
  readonly cancel: (ids: readonly string[]) => readonly ChildAgentSnapshot[];
  readonly cancelAll: () => readonly ChildAgentSnapshot[];
};

export function snapshot(record: ChildRecord): ChildAgentSnapshot {
  const output = record.result?.text;
  return {
    id: record.id,
    status: record.status,
    prompt: record.prompt,
    ...(record.result
      ? {
          output:
            output && output.length > record.maxOutputChars
              ? `${output.slice(0, record.maxOutputChars)}...`
              : output,
          finishReason: record.result.finishReason,
        }
      : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}
