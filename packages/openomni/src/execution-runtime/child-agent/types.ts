import type {
  AgentResult,
  ChatAgentConfig,
  ChatAgentInput,
  ChatAgentInstance,
} from "@openomni/agent";
import type { Model, ToolSelection, TraceContext } from "@openomni/protocol";
import type { NativeTool } from "../tool/types.js";

export type ChildStatus = "running" | "completed" | "failed" | "cancelled";

export const DEFAULT_MAX_CHILDREN = 4;
export const DEFAULT_AWAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 4_000;

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
  readonly createAgent: (config: ChatAgentConfig) => Pick<ChatAgentInstance, "run">;
};

export type ChildAgentSpawnInput = {
  readonly prompt: string;
  readonly tools?: ToolSelection.Selection;
};

export type ChildRecord = {
  readonly id: string;
  readonly prompt: string;
  readonly controller: AbortController;
  status: ChildStatus;
  readonly maxOutputChars: number;
  result?: AgentResult;
  error?: string;
  completion: Promise<void>;
};

export type ChildAgentRuntime = {
  readonly spawn: (input: ChildAgentSpawnInput) => ChildAgentSnapshot;
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
