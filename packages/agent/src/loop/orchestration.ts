import type {
  RunOutcome,
  Sink,
  ToolCall,
  ToolResult,
} from "@openomni/protocol";
import { RunWorker } from "./run-worker";

type PermissionLevel = "ask" | "notify" | "deny";

export type SessionMode = "ephemeral" | "persistent" | "reuse";

export interface OrchestratorConfig {
  taskId: string;
  runId: string;
  maxRetries: number;
  sessionMode?: SessionMode;
  sessionId?: string;
  maxSubagentDepth?: number;
  currentDepth?: number;
}

export interface OrchestrationResult {
  success: boolean;
  summary: string;
  error: string;
}

export interface OrchestrationState {
  attempt: number;
  turns: number;
  toolCalls: number;
  lastError: string;
}

export interface ToolExecutor {
  execute(calls: ToolCall[]): Promise<ToolResult[]>;
}

export interface OrchestratorRunInput {
  llm: {
    run(input: Record<string, unknown>, sink: Sink): Promise<RunOutcome>;
  };
  input: Record<string, unknown>;
  toolExecutor?: ToolExecutor;
  permission?: {
    agentPolicy?: PermissionLevel;
    systemDefault?: PermissionLevel;
  };
}

export namespace Orchestrator {
  export async function run(
    config: OrchestratorConfig,
    input: OrchestratorRunInput,
  ): Promise<OrchestrationResult> {
    return RunWorker.run(config, input);
  }
}
