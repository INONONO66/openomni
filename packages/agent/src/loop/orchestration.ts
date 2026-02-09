import type {
  Message,
  RetryPolicy,
  RunOutcome,
  Sink,
  ToolCall,
  ToolResult,
} from "@openomni/protocol";
import { Session } from "@openomni/session";
import type { Task } from "../task/types";
import { TaskManager } from "../task/manager";
import { PermissionGate } from "./permission";
import { RunSupervisor } from "./run-supervisor";
import { ConcurrencyGate } from "./concurrency";
import { Observability } from "./observability";
import { AuditLog } from "./audit";
import { DeadLetterQueue } from "./dlq";
import { SummaryDelivery } from "./summary";

type RetryReason =
  | "timeout"
  | "tool_error"
  | "transient_error"
  | "validation_error";

type PermissionLevel = "ask" | "notify" | "deny";

const DEFAULT_PERMISSION: PermissionLevel = "notify";

const DEFAULT_BUDGET = {
  maxWallTimeMs: 5 * 60 * 1000,
  maxTurns: 24,
  maxToolCalls: 40,
  maxToolRuntimeMs: 2 * 60 * 1000,
};

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  backoffMs: {
    initial: 1000,
    multiplier: 2,
    max: 30_000,
  },
  retryOn: ["timeout", "tool_error", "transient_error"],
};

const DEFAULT_CONCURRENCY = {
  maxRunning: 1,
  mode: "drop" as const,
};

const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

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

interface ToolPartRef {
  messageID: string;
  partID: string;
  input: Record<string, unknown>;
  startedAt: number;
}

const fallbackToolExecutor: ToolExecutor = {
  async execute(calls: ToolCall[]): Promise<ToolResult[]> {
    return calls.map((call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: `Tool '${call.tool}' is not configured`,
      isError: true,
    }));
  },
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveRetryPolicy(
  configured: RetryPolicy | undefined,
  maxRetries: number,
): RetryPolicy {
  const cappedRetries = Math.max(0, Math.floor(maxRetries));
  const cappedAttempts = cappedRetries + 1;

  if (!configured) {
    return {
      maxAttempts: cappedAttempts,
      backoffMs: { ...DEFAULT_RETRY_POLICY.backoffMs },
      retryOn: [...(DEFAULT_RETRY_POLICY.retryOn ?? [])],
    };
  }

  return {
    maxAttempts: Math.max(1, Math.min(configured.maxAttempts, cappedAttempts)),
    backoffMs: {
      initial: configured.backoffMs.initial,
      multiplier: configured.backoffMs.multiplier,
      max: configured.backoffMs.max,
    },
    retryOn: configured.retryOn ? [...configured.retryOn] : undefined,
  };
}

function resolveBudget(task: Task.Info) {
  return task.policy.budget ?? DEFAULT_BUDGET;
}

function calculateBackoffMs(policy: RetryPolicy, attempt: number): number {
  const rawDelay =
    policy.backoffMs.initial *
    Math.pow(policy.backoffMs.multiplier, Math.max(0, attempt - 1));
  return Math.min(rawDelay, policy.backoffMs.max);
}

function classifyRetryReason(errorMessage: string): RetryReason {
  const normalized = errorMessage.toLowerCase();

  if (
    normalized.includes("timeout") ||
    normalized.includes("aborted") ||
    normalized.includes("budget exceeded")
  ) {
    return "timeout";
  }

  if (normalized.includes("tool")) {
    return "tool_error";
  }

  if (normalized.includes("validation")) {
    return "validation_error";
  }

  return "transient_error";
}

function shouldRetry(
  policy: RetryPolicy,
  reason: RetryReason,
  attempt: number,
): boolean {
  if (attempt >= policy.maxAttempts) {
    return false;
  }

  if (!policy.retryOn || policy.retryOn.length === 0) {
    return true;
  }

  return policy.retryOn.includes(reason);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.floor(ms)));
  });
}

function createEphemeralSession(
  taskId: string,
  runId: string,
  sessionKey: string,
): Session.Info {
  const existing = Session.get(sessionKey);
  if (existing) {
    Session.remove(sessionKey);
  }

  const now = Date.now();
  const session: Session.Info = {
    id: sessionKey,
    title: `Task ${taskId} Run ${runId}`,
    model: {
      providerID: "agent",
      modelID: "orchestrator",
    },
    time: {
      created: now,
      updated: now,
    },
  };

  Session.storage.set(session.id, session);
  return session;
}

function createSyntheticAssistantMessage(
  sessionID: string,
): Message.AssistantMessage {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    sessionID,
    role: "assistant",
    time: {
      created: now,
      completed: now,
    },
    parentID: crypto.randomUUID(),
    modelID: "orchestrator",
    providerID: "agent",
    agent: "orchestrator",
    path: {
      cwd: process.cwd(),
      root: process.cwd(),
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  };
}

function serializeSnapshot(snapshot: {
  id: string;
  timestamp: number;
}): string {
  return `${snapshot.id}:${snapshot.timestamp}`;
}

function createSessionSink(sessionID: string): Sink {
  const toolRefs = new Map<string, ToolPartRef>();
  let activeMessageID: string | undefined;

  const ensureMessageID = () => {
    if (activeMessageID) {
      return activeMessageID;
    }

    const message = createSyntheticAssistantMessage(sessionID);
    Session.addMessage(sessionID, message);
    activeMessageID = message.id;
    return activeMessageID;
  };

  return {
    onMessage(message) {
      const normalizedInfo: Message.Info = {
        ...message.info,
        sessionID,
      };

      Session.addMessage(sessionID, normalizedInfo);
      activeMessageID = normalizedInfo.id;

      for (const part of message.parts) {
        const normalizedPart: Message.Part = {
          ...part,
          sessionID,
          messageID: normalizedInfo.id,
        };

        Session.addPart(normalizedInfo.id, normalizedPart);

        if (normalizedPart.type === "tool") {
          const startedAt =
            normalizedPart.state.status === "running" ||
            normalizedPart.state.status === "completed" ||
            normalizedPart.state.status === "error"
              ? normalizedPart.state.time.start
              : Date.now();

          toolRefs.set(normalizedPart.callID, {
            messageID: normalizedInfo.id,
            partID: normalizedPart.id,
            input: normalizedPart.state.input,
            startedAt,
          });
        }
      }
    },

    onToolCall(call) {
      if (toolRefs.has(call.id)) {
        return;
      }

      const messageID = ensureMessageID();
      const toolPart: Message.ToolPart = {
        id: crypto.randomUUID(),
        sessionID,
        messageID,
        type: "tool",
        callID: call.id,
        tool: call.tool,
        state: {
          status: "pending",
          input: call.input,
        },
      };

      Session.addPart(messageID, toolPart);

      toolRefs.set(call.id, {
        messageID,
        partID: toolPart.id,
        input: call.input,
        startedAt: Date.now(),
      });
    },

    onToolResult(result) {
      const ref = toolRefs.get(result.toolCallId);
      const messageID = ref?.messageID ?? ensureMessageID();
      const partID = ref?.partID ?? crypto.randomUUID();
      const input = ref?.input ?? {};
      const startedAt = ref?.startedAt ?? Date.now();
      const completedAt = Date.now();

      const toolPart: Message.ToolPart = result.isError
        ? {
            id: partID,
            sessionID,
            messageID,
            type: "tool",
            callID: result.toolCallId,
            tool: "unknown",
            state: {
              status: "error",
              input,
              error: result.output,
              time: {
                start: startedAt,
                end: completedAt,
              },
            },
          }
        : {
            id: partID,
            sessionID,
            messageID,
            type: "tool",
            callID: result.toolCallId,
            tool: "unknown",
            state: {
              status: "completed",
              input,
              output: result.output,
              title: result.id,
              metadata: {},
              time: {
                start: startedAt,
                end: completedAt,
              },
            },
          };

      if (ref) {
        Session.updatePart(messageID, toolPart);
      } else {
        Session.addPart(messageID, toolPart);
      }

      toolRefs.delete(result.toolCallId);
    },

    onSnapshot(snapshot) {
      const messageID = ensureMessageID();
      const part: Message.SnapshotPart = {
        id: crypto.randomUUID(),
        sessionID,
        messageID,
        type: "snapshot",
        snapshot: serializeSnapshot({
          id: snapshot.id,
          timestamp: snapshot.timestamp,
        }),
      };
      Session.addPart(messageID, part);
    },
  };
}

function extractSummary(sessionID: string): string {
  const messages = Session.getMessages(sessionID);

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") {
      continue;
    }

    const parts = Session.getParts(message.id);
    const text = parts
      .filter((part): part is Message.TextPart => part.type === "text")
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  return "No summary generated.";
}

export namespace Orchestrator {
  export async function run(
    config: OrchestratorConfig,
    input: OrchestratorRunInput,
  ): Promise<OrchestrationResult> {
    const task = TaskManager.get(config.taskId);
    if (!task) {
      return {
        success: false,
        summary: "",
        error: `Task not found: ${config.taskId}`,
      };
    }

    const taskRun = TaskManager.getRun(config.runId);
    if (!taskRun) {
      return {
        success: false,
        summary: "",
        error: `TaskRun not found: ${config.runId}`,
      };
    }

    const maxDepth = config.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
    const currentDepth = config.currentDepth ?? 0;

    if (currentDepth >= maxDepth) {
      return {
        success: false,
        summary: "",
        error: `Subagent depth limit reached: ${currentDepth} >= ${maxDepth}`,
      };
    }

    const activeRuns = TaskManager.listRunsByStatus(["running", "blocked"]);
    const runningCount = activeRuns.filter(
      (run) => run.taskId === config.taskId && run.runId !== config.runId,
    ).length;

    const concurrencyDecision = ConcurrencyGate.check(
      config.taskId,
      runningCount,
      task.policy.concurrency ?? DEFAULT_CONCURRENCY,
    );
    ConcurrencyGate.record(config.taskId, concurrencyDecision);

    if (concurrencyDecision !== "allow") {
      return {
        success: false,
        summary: "",
        error:
          concurrencyDecision === "queue"
            ? "Run queued by concurrency policy"
            : "Run dropped by concurrency policy",
      };
    }

    const permission = PermissionGate.evaluate({
      taskPolicy: task.policy.permission,
      agentPolicy: input.permission?.agentPolicy,
      systemDefault: input.permission?.systemDefault ?? DEFAULT_PERMISSION,
    });

    // Log permission decision
    AuditLog.logPermission(config.runId, permission);

    if (permission.level === "deny") {
      TaskManager.setRunStatus(
        config.runId,
        "failed",
        permission.reason ?? "Permission denied",
      );

      return {
        success: false,
        summary: "",
        error: permission.reason ?? "Permission denied",
      };
    }

    if (permission.level === "ask" && taskRun.status === "blocked") {
      return {
        success: false,
        summary: "",
        error: "Run is waiting for approval",
      };
    }

    const sessionMode: SessionMode = config.sessionMode ?? "ephemeral";
    let session: Session.Info;

    if (sessionMode === "reuse") {
      if (!config.sessionId) {
        return {
          success: false,
          summary: "",
          error: "sessionId is required when sessionMode is 'reuse'",
        };
      }
      const existing = Session.get(config.sessionId);
      if (!existing) {
        return {
          success: false,
          summary: "",
          error: `Session not found for reuse: ${config.sessionId}`,
        };
      }
      session = existing;
    } else {
      session = createEphemeralSession(
        config.taskId,
        config.runId,
        taskRun.sessionKey,
      );
    }

    const sink = createSessionSink(session.id);

    const retryPolicy = resolveRetryPolicy(
      task.policy.retry,
      config.maxRetries,
    );
    const runBudget = resolveBudget(task);
    const toolExecutor = input.toolExecutor ?? fallbackToolExecutor;

    let currentInput: Record<string, unknown> = { ...input.input };
    let accumulatedToolResults: ToolResult[] = [];
    let runState = RunSupervisor.createState();
    let lastError = "";

    // Emit run start event
    Observability.emitRunEvent(config.runId, "started", {
      budgetUsage: 0,
      durationMs: 0,
      turnCount: 0,
    });

    try {
      let attempt = 1;

      while (attempt <= retryPolicy.maxAttempts) {
        TaskManager.setRunStatus(config.runId, "running");

        try {
          while (true) {
            const budgetStatus = RunSupervisor.checkBudget(runState, runBudget);
            if (budgetStatus === "exceeded") {
              throw new Error("Run budget exceeded");
            }

            runState = RunSupervisor.recordTurn(runState);

            const outcome = await input.llm.run(
              {
                ...currentInput,
                taskId: config.taskId,
                runId: config.runId,
                sessionID: session.id,
                attempt,
                toolResults: accumulatedToolResults,
              },
              sink,
            );

            if (outcome.type === "stop") {
              const summary = extractSummary(session.id);

              // Persist summary before status update
              SummaryDelivery.persist(config.runId, summary);

              TaskManager.setRunStatus(config.runId, "done");

              // Log successful outcome
              const durationMs = Date.now() - runState.startTime;
              const budgetUsage = Math.max(
                runState.turns / runBudget.maxTurns,
                runState.toolCalls / runBudget.maxToolCalls,
                runState.toolRuntimeMs / runBudget.maxToolRuntimeMs,
                durationMs / runBudget.maxWallTimeMs,
              );

              AuditLog.logRunOutcome(config.runId, {
                success: true,
                summary,
                durationMs,
                turnCount: runState.turns,
                toolCallCount: runState.toolCalls,
              });

              // Emit run completion event
              Observability.emitRunEvent(config.runId, "completed", {
                budgetUsage,
                durationMs,
                turnCount: runState.turns,
              });

              return {
                success: true,
                summary,
                error: "",
              };
            }

            if (outcome.type === "aborted") {
              throw new Error("Run aborted");
            }

            if (outcome.type === "error") {
              throw outcome.error;
            }

            if (outcome.toolCalls.length === 0) {
              throw new Error("Tool wait requested with no tool calls");
            }

            const toolStart = Date.now();
            const toolResults = await toolExecutor.execute(outcome.toolCalls);
            const elapsed = Date.now() - toolStart;
            const perToolRuntimeMs =
              toolResults.length > 0
                ? Math.max(1, Math.ceil(elapsed / toolResults.length))
                : elapsed;

            for (const result of toolResults) {
              sink.onToolResult(result);
              accumulatedToolResults = [...accumulatedToolResults, result];
              runState = RunSupervisor.recordToolCall(
                runState,
                perToolRuntimeMs,
              );
            }

            currentInput = {
              ...currentInput,
              toolResults: accumulatedToolResults,
            };
          }
        } catch (error) {
          lastError = toErrorMessage(error);
          const retryReason = classifyRetryReason(lastError);

          if (shouldRetry(retryPolicy, retryReason, attempt)) {
            TaskManager.setRunStatus(
              config.runId,
              "scheduled",
              `retrying:${retryReason}`,
            );

            const backoffMs = calculateBackoffMs(retryPolicy, attempt);
            await sleep(backoffMs);
            attempt += 1;
            continue;
          }

          // Retries exhausted - add to DLQ
          DeadLetterQueue.add({
            type: "run",
            reason: lastError,
            attempts: attempt,
            payload: {
              runId: config.runId,
              taskId: config.taskId,
              input: currentInput,
              lastError,
              retryReason,
            },
          });

          const summary = extractSummary(session.id);

          // Persist summary before status update
          SummaryDelivery.persist(config.runId, summary);

          TaskManager.setRunStatus(config.runId, "failed", lastError);

          // Log failed outcome
          const durationMs = Date.now() - runState.startTime;
          const budgetUsage = Math.max(
            runState.turns / runBudget.maxTurns,
            runState.toolCalls / runBudget.maxToolCalls,
            runState.toolRuntimeMs / runBudget.maxToolRuntimeMs,
            durationMs / runBudget.maxWallTimeMs,
          );

          AuditLog.logRunOutcome(config.runId, {
            success: false,
            summary,
            error: lastError,
            durationMs,
            turnCount: runState.turns,
            toolCallCount: runState.toolCalls,
          });

          // Emit run failed event
          Observability.emitRunEvent(config.runId, "failed", {
            budgetUsage,
            durationMs,
            turnCount: runState.turns,
          });

          return {
            success: false,
            summary,
            error: lastError,
          };
        }
      }

      // All retry attempts exhausted
      DeadLetterQueue.add({
        type: "run",
        reason: lastError || "Retry attempts exhausted",
        attempts: retryPolicy.maxAttempts,
        payload: {
          runId: config.runId,
          taskId: config.taskId,
          input: currentInput,
          lastError,
        },
      });

      const summary = extractSummary(session.id);

      // Persist summary before status update
      SummaryDelivery.persist(config.runId, summary);

      TaskManager.setRunStatus(config.runId, "failed", lastError);

      // Log failed outcome
      const durationMs = Date.now() - runState.startTime;
      const budgetUsage = Math.max(
        runState.turns / runBudget.maxTurns,
        runState.toolCalls / runBudget.maxToolCalls,
        runState.toolRuntimeMs / runBudget.maxToolRuntimeMs,
        durationMs / runBudget.maxWallTimeMs,
      );

      AuditLog.logRunOutcome(config.runId, {
        success: false,
        summary,
        error: lastError || "Retry attempts exhausted",
        durationMs,
        turnCount: runState.turns,
        toolCallCount: runState.toolCalls,
      });

      // Emit run failed event
      Observability.emitRunEvent(config.runId, "failed", {
        budgetUsage,
        durationMs,
        turnCount: runState.turns,
      });

      return {
        success: false,
        summary,
        error: lastError || "Retry attempts exhausted",
      };
    } finally {
      if (sessionMode === "ephemeral") {
        Session.remove(session.id);
      }
    }
  }
}
