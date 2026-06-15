import type { Model, Policy, Subagent } from "@openomni/protocol";
import type { RuntimeConfig } from "./transcript.js";

export type BackgroundLaunchInput = {
  readonly agentName: string;
  readonly prompt: string;
  readonly model: Model.Ref;
  readonly parentSessionId: string;
  readonly depth?: number;
  readonly permissions?: Policy.Permission;
  readonly systemPrompt?: RuntimeConfig["systemPrompt"];
  readonly tools?: RuntimeConfig["tools"];
  readonly toolExecutor?: RuntimeConfig["toolExecutor"];
  readonly middleware?: RuntimeConfig["middleware"];
  readonly childMiddleware?: RuntimeConfig["childMiddleware"];
};

export type BackgroundManagerConfig = {
  readonly maxConcurrentPerAgent?: number;
  readonly maxConcurrentTotal?: number;
  readonly maxDepth?: number;
  readonly maxDescendants?: number;
  readonly taskTtlMs?: number;
  readonly maxQueueSize?: number;
  readonly resolveAuth?: (provider: string) => RuntimeConfig["auth"];
  readonly allowAuthFallback?: RuntimeConfig["allowAuthFallback"];
  readonly onTaskComplete?: (result: Subagent.BackgroundTaskResult) => void;
};

export type ResolvedBackgroundManagerConfig = {
  readonly maxConcurrentPerAgent: number;
  readonly maxConcurrentTotal: number;
  readonly maxDepth: number;
  readonly maxDescendants: number;
  readonly taskTtlMs: number;
  readonly maxQueueSize: number;
  readonly resolveAuth?: (provider: string) => RuntimeConfig["auth"];
  readonly allowAuthFallback?: RuntimeConfig["allowAuthFallback"];
  readonly onTaskComplete?: (result: Subagent.BackgroundTaskResult) => void;
};

export type BackgroundManagerInstance = {
  launch(input: BackgroundLaunchInput): Promise<Subagent.BackgroundTask>;
  getTask(taskId: string): Subagent.BackgroundTask | undefined;
  getResult(taskId: string): Subagent.BackgroundTaskResult | undefined;
  cancel(taskId: string): Promise<boolean>;
  listByParent(parentSessionId: string): Subagent.BackgroundTask[];
  cleanup(): void;
  stats(): { active: number; pending: number; total: number };
  dispose(): void;
};

export type QueuedBackgroundLaunch = {
  readonly input: BackgroundLaunchInput;
  readonly id: string;
};

export function resolveBackgroundManagerConfig(
  config?: BackgroundManagerConfig,
): ResolvedBackgroundManagerConfig {
  return {
    maxConcurrentPerAgent: config?.maxConcurrentPerAgent ?? 3,
    maxConcurrentTotal: config?.maxConcurrentTotal ?? 10,
    maxDepth: config?.maxDepth ?? 5,
    maxDescendants: config?.maxDescendants ?? 10,
    taskTtlMs: config?.taskTtlMs ?? 1_800_000,
    maxQueueSize: config?.maxQueueSize ?? 100,
    resolveAuth: config?.resolveAuth,
    allowAuthFallback: config?.allowAuthFallback,
    onTaskComplete: config?.onTaskComplete,
  };
}
