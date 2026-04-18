import { ChatAgent, type ChatAgentConfig } from "@openomni/agent";
import { type Guardrail, type Message, Subagent } from "@openomni/protocol";
import { Bus, type BusEvent, Session, WorkerRun, type WorkerRunRecord } from "@openomni/session";
import {
  abort as abortSession,
  get as getAbortEntry,
  register as registerAbortController,
  remove as removeAbortController,
} from "./abort-registry";
import { sendToMailbox } from "./session-mailbox.js";
import {
  type RuntimeModel,
  type RuntimeMessage,
  toSessionModel,
  createUserMessage,
  createAssistantMessage,
  addTextPart,
  publishEvent,
} from "./shared";
import {
  addAssistantResultParts,
  buildRuntimeMessages,
  buildSessionMessagesWithParts,
  estimateRuntimeTokens,
} from "./message-builder";

type RuntimeConfig = {
  model: RuntimeModel;
  systemPrompt?: string;
  tools?: ChatAgentConfig["tools"];
  toolExecutor?: ChatAgentConfig["toolExecutor"];
  budget?: ChatAgentConfig["budget"];
};

type SendCompactionConfig = {
  contextWindowTokens: number;
  thresholdRatio?: number;
  onSummarize?: (messages: RuntimeMessage[]) => Promise<string>;
};

type InMemoryCompactorLike = {
  shouldCompact(
    totalTokens: number,
    options: {
      contextWindowTokens: number;
      thresholdRatio?: number;
    },
  ): boolean;
  compact(
    messages: Message.WithParts[],
    options: {
      contextWindowTokens: number;
      thresholdRatio?: number;
      onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
    },
  ): Promise<{
    messages: Message.WithParts[];
    compacted: boolean;
    removedCount: number;
  }>;
};

async function loadInMemoryCompactor(): Promise<InMemoryCompactorLike> {
  const module = (await import(
    new URL("../../../agent/src/core/execution/compaction.ts", import.meta.url).href
  )) as { InMemoryCompactor: InMemoryCompactorLike };

  return module.InMemoryCompactor;
}

function buildChildMessagesInternal(sessionId: string, repair?: boolean): RuntimeMessage[] {
  return buildRuntimeMessages(buildSessionMessagesWithParts(sessionId), repair);
}

async function maybeCompactSendTranscript(
  sessionId: string,
  messages: RuntimeMessage[],
  compaction?: SendCompactionConfig,
): Promise<RuntimeMessage[]> {
  if (!compaction) {
    return messages;
  }

  const compactor = await loadInMemoryCompactor();
  const totalTokens = estimateRuntimeTokens(messages);
  if (
    !compactor.shouldCompact(totalTokens, {
      contextWindowTokens: compaction.contextWindowTokens,
      thresholdRatio: compaction.thresholdRatio,
    })
  ) {
    return messages;
  }

  const anchor = messages.find((message) => message.role === "user")?.content;
  const result = await compactor.compact(buildSessionMessagesWithParts(sessionId), {
    contextWindowTokens: compaction.contextWindowTokens,
    thresholdRatio: compaction.thresholdRatio,
    onSummarize: compaction.onSummarize
      ? async (messagesToSummarize) =>
          compaction.onSummarize!(buildRuntimeMessages(messagesToSummarize))
      : undefined,
  });

  if (!result.compacted) {
    return messages;
  }

  const compactedMessages = buildRuntimeMessages(result.messages);
  if (!anchor) {
    return compactedMessages;
  }

  return [{ role: "user", content: `Original goal: ${anchor}` }, ...compactedMessages];
}

async function runWithTranscript(
  sessionId: string,
  config: RuntimeConfig,
  signal?: AbortSignal,
  permissions?: Guardrail.ToolPermission,
  messages = buildChildMessagesInternal(sessionId),
): Promise<Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>> {
  const agent = ChatAgent.create({
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    budget: config.budget,
    toolExecutor: config.toolExecutor,
    signal,
    permissions,
  });

  return agent.run({ messages });
}

function buildAbortSignal(controller: AbortController, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any(
    [controller.signal, signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
}

async function shouldSkipFailureUpdate(sessionId: string, runId: string): Promise<boolean> {
  const run = await WorkerRun.get(sessionId, runId);
  if (run?.status === "cancelled" || run?.status === "interrupted") return true;
  // Cancel in progress: controller aborted but entry kept for completion tracking
  const entry = getAbortEntry(sessionId, runId);
  return !!entry && entry.controller.signal.aborted;
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function resolveMetaStatus(runStatus: string | undefined): string {
  switch (runStatus) {
    case "succeeded":
      return "idle";
    case "failed":
    case "cancelled":
    case "interrupted":
      return runStatus;
    default:
      return "idle";
  }
}

async function finalizeRun(sessionId: string, runId: string): Promise<void> {
  const run = await WorkerRun.get(sessionId, runId);
  if (run && !isTerminalStatus(run.status) && !(await shouldSkipFailureUpdate(sessionId, runId))) {
    await WorkerRun.updateStatus(sessionId, runId, "failed", { endedAt: Date.now() });
    publishEvent(Subagent.Events.WorkerRunFailed, {
      sessionId,
      runId,
      error: "non-terminal status at finally cleanup",
    });
  }

  const finalRun = await WorkerRun.get(sessionId, runId);
  const meta = Session.getWorkerMeta(sessionId);
  if (meta && typeof meta === "object") {
    Session.updateWorkerMeta(sessionId, {
      ...meta,
      status: resolveMetaStatus(finalRun?.status),
    });
  }
}

async function waitForAbortEntryRemoval(sessionId: string, runId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (getAbortEntry(sessionId, runId) === undefined) return;
    await Promise.resolve();
  }
  while (getAbortEntry(sessionId, runId) !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function raceAbortCompletion(
  sessionId: string,
  runId: string,
  hardTimeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortWait = waitForAbortEntryRemoval(sessionId, runId).then(() => "settled" as const);
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), hardTimeoutMs);
  });

  const winner = await Promise.race([abortWait, timeout]);

  if (winner === "timeout") {
    removeAbortController(sessionId, runId);
    const run = await WorkerRun.get(sessionId, runId);
    if (run && !isTerminalStatus(run.status)) {
      await WorkerRun.updateStatus(sessionId, runId, "interrupted", { endedAt: Date.now() });
    }
    publishEvent(Subagent.Events.WorkerRunFailed, {
      sessionId,
      runId,
      error: "cancel timeout exceeded",
    });
  } else {
    clearTimeout(timeoutId);
    const run = await WorkerRun.get(sessionId, runId);
    if (run && !isTerminalStatus(run.status)) {
      await WorkerRun.updateStatus(sessionId, runId, "cancelled", { endedAt: Date.now() });
    }
  }
}

type TimeoutTimers = {
  soft?: ReturnType<typeof setTimeout>;
  hard?: ReturnType<typeof setTimeout>;
};

function setupRunTimeouts(
  sessionId: string,
  runId: string,
  softTimeoutMs?: number,
  hardTimeoutMs?: number,
): TimeoutTimers {
  const timers: TimeoutTimers = {};

  if (softTimeoutMs !== undefined) {
    timers.soft = setTimeout(() => {
      publishEvent(Subagent.Events.WorkerRunFailed, {
        sessionId,
        runId,
        error: "soft timeout exceeded",
      });
    }, softTimeoutMs);
  }

  if (hardTimeoutMs !== undefined) {
    timers.hard = setTimeout(async () => {
      try {
        await WorkerRun.updateStatus(sessionId, runId, "interrupted", { endedAt: Date.now() });
      } catch {
        return;
      }
      publishEvent(Subagent.Events.WorkerRunFailed, {
        sessionId,
        runId,
        error: "hard timeout exceeded",
      });
      abortSession(sessionId, runId);
    }, hardTimeoutMs);
  }

  return timers;
}

function clearRunTimeouts(timers: TimeoutTimers): void {
  if (timers.soft) clearTimeout(timers.soft);
  if (timers.hard) clearTimeout(timers.hard);
}

export namespace SubagentRuntime {
  export interface SpawnConfig extends RuntimeConfig {
    parentSessionId?: string;
    agentName: string;
    title: string;
    prompt: string;
    category?: string;
    signal?: AbortSignal;
    softTimeoutMs?: number;
    hardTimeoutMs?: number;
    permissions?: Guardrail.ToolPermission;
  }

  export interface SendConfig extends RuntimeConfig {
    sessionId: string;
    prompt: string;
    signal?: AbortSignal;
    softTimeoutMs?: number;
    hardTimeoutMs?: number;
    permissions?: Guardrail.ToolPermission;
    compaction?: SendCompactionConfig;
  }

  export interface WaitConfig {
    sessionId: string;
    runId: string;
    timeoutMs?: number;
  }

  export interface RunResult {
    sessionId: string;
    runId: string;
    output: string;
    finishReason: Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>["finishReason"];
  }

  export interface SpawnBackgroundResult {
    sessionId: string;
    runId: string;
  }

  export interface WaitResult {
    status: Awaited<ReturnType<typeof WorkerRun.get>> extends infer T
      ? T extends { status: infer S }
        ? S
        : never
      : never;
    output?: string;
  }

  export function spawn(config: SpawnConfig): Promise<RunResult> {
    const workerMeta = Subagent.ChildSessionMeta.parse({
      kind: "subagent",
      parentSessionId: config.parentSessionId,
      agentName: config.agentName,
      spawnDepth: config.parentSessionId ? undefined : 0,
      status: "idle",
    });

    const session = config.parentSessionId
      ? Session.createChild({
          parentSessionId: config.parentSessionId,
          title: config.title,
          model: toSessionModel(config.model),
          workerMeta,
        })
      : Session.create({
          title: config.title,
          model: toSessionModel(config.model),
        });

    if (!config.parentSessionId) {
      Session.updateWorkerMeta(session.id, workerMeta);
    }

    publishEvent(Subagent.Events.WorkerSessionSpawned, {
      sessionId: session.id,
      parentSessionId: config.parentSessionId,
      agentName: config.agentName,
      spawnDepth: session.spawnDepth,
      kind: "subagent",
    });

    return sendToMailbox(session.id, async () => {
      const userMessage = createUserMessage(session.id, config.model);
      Session.addMessage(session.id, userMessage);
      addTextPart(session.id, userMessage.id, config.prompt);

      const runId = crypto.randomUUID();
      await WorkerRun.create(session.id, {
        runId,
        title: config.title,
        prompt: config.prompt,
      });
      const abortEntry = registerAbortController(session.id, runId);
      const signal = buildAbortSignal(abortEntry.controller, config.signal);
      const timers = setupRunTimeouts(
        session.id,
        runId,
        config.softTimeoutMs,
        config.hardTimeoutMs,
      );
      await WorkerRun.updateStatus(session.id, runId, "starting");
      publishEvent(Subagent.Events.WorkerRunStarted, {
        sessionId: session.id,
        runId,
        title: config.title,
      });

      try {
        await WorkerRun.updateStatus(session.id, runId, "running");
        const permissions = config.permissions ?? { denylist: ["subagent"] };
        const result = await runWithTranscript(session.id, config, signal, permissions);

        const assistantMessage = createAssistantMessage(session.id, config.model);
        Session.addMessage(session.id, assistantMessage);
        addAssistantResultParts(session.id, assistantMessage.id, result);

        await WorkerRun.updateStatus(session.id, runId, "succeeded", {
          endedAt: Date.now(),
          lastMessageId: assistantMessage.id,
        });

        publishEvent(Subagent.Events.WorkerRunCompleted, {
          sessionId: session.id,
          runId,
          status: "succeeded",
        });

        return {
          sessionId: session.id,
          runId,
          output: result.text,
          finishReason: result.finishReason,
        };
      } catch (error) {
        if (await shouldSkipFailureUpdate(session.id, runId)) {
          throw error;
        }

        await WorkerRun.updateStatus(session.id, runId, "failed", {
          endedAt: Date.now(),
        });
        publishEvent(Subagent.Events.WorkerRunFailed, {
          sessionId: session.id,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        clearRunTimeouts(timers);
        try {
          await finalizeRun(session.id, runId);
        } catch {
          // cleanup must not mask the original error
        }
        removeAbortController(session.id, runId);
      }
    });
  }

  export async function spawnBackground(config: SpawnConfig): Promise<SpawnBackgroundResult> {
    const workerMeta = Subagent.ChildSessionMeta.parse({
      kind: "subagent",
      parentSessionId: config.parentSessionId,
      agentName: config.agentName,
      spawnDepth: config.parentSessionId ? undefined : 0,
      status: "idle",
    });

    const session = config.parentSessionId
      ? Session.createChild({
          parentSessionId: config.parentSessionId,
          title: config.title,
          model: toSessionModel(config.model),
          workerMeta,
        })
      : Session.create({
          title: config.title,
          model: toSessionModel(config.model),
        });

    if (!config.parentSessionId) {
      Session.updateWorkerMeta(session.id, workerMeta);
    }

    publishEvent(Subagent.Events.WorkerSessionSpawned, {
      sessionId: session.id,
      parentSessionId: config.parentSessionId,
      agentName: config.agentName,
      spawnDepth: session.spawnDepth,
      kind: "subagent",
    });

    const userMessage = createUserMessage(session.id, config.model);
    Session.addMessage(session.id, userMessage);
    addTextPart(session.id, userMessage.id, config.prompt);

    const runId = crypto.randomUUID();
    await WorkerRun.create(session.id, {
      runId,
      title: config.title,
      prompt: config.prompt,
    });

    const abortEntry = registerAbortController(session.id, runId);
    const signal = buildAbortSignal(abortEntry.controller, config.signal);
    const timers = setupRunTimeouts(session.id, runId, config.softTimeoutMs, config.hardTimeoutMs);

    await WorkerRun.updateStatus(session.id, runId, "starting");
    publishEvent(Subagent.Events.WorkerRunStarted, {
      sessionId: session.id,
      runId,
      title: config.title,
    });
    await WorkerRun.updateStatus(session.id, runId, "running");

    const backgroundRun = sendToMailbox(session.id, async () => {
      try {
        const permissions = config.permissions ?? { denylist: ["subagent"] };
        const result = await runWithTranscript(session.id, config, signal, permissions);

        const assistantMessage = createAssistantMessage(session.id, config.model);
        Session.addMessage(session.id, assistantMessage);
        addAssistantResultParts(session.id, assistantMessage.id, result);

        await WorkerRun.updateStatus(session.id, runId, "succeeded", {
          endedAt: Date.now(),
          lastMessageId: assistantMessage.id,
        });

        publishEvent(Subagent.Events.WorkerRunCompleted, {
          sessionId: session.id,
          runId,
          status: "succeeded",
        });
      } catch (error) {
        if (await shouldSkipFailureUpdate(session.id, runId)) {
          throw error;
        }

        await WorkerRun.updateStatus(session.id, runId, "failed", {
          endedAt: Date.now(),
        });
        publishEvent(Subagent.Events.WorkerRunFailed, {
          sessionId: session.id,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        clearRunTimeouts(timers);
        try {
          await finalizeRun(session.id, runId);
        } catch {
          // cleanup must not mask the original error
        }
        removeAbortController(session.id, runId);
      }
    });

    backgroundRun.catch(() => undefined);

    return {
      sessionId: session.id,
      runId,
    };
  }

  export function send(config: SendConfig): Promise<RunResult> {
    const session = Session.get(config.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${config.sessionId}`);
    }

    return sendToMailbox(session.id, async () => {
      const userMessage = createUserMessage(session.id, config.model);
      Session.addMessage(session.id, userMessage);
      addTextPart(session.id, userMessage.id, config.prompt);

      const runId = crypto.randomUUID();
      await WorkerRun.create(session.id, {
        runId,
        title: "retry",
        prompt: config.prompt,
      });
      const abortEntry = registerAbortController(session.id, runId);
      const signal = buildAbortSignal(abortEntry.controller, config.signal);
      const timers = setupRunTimeouts(
        session.id,
        runId,
        config.softTimeoutMs,
        config.hardTimeoutMs,
      );
      await WorkerRun.updateStatus(session.id, runId, "starting");
      await WorkerRun.updateStatus(session.id, runId, "running");

      try {
        const permissions = config.permissions ?? { denylist: ["subagent"] };
        const messages = await maybeCompactSendTranscript(
          session.id,
          buildChildMessagesInternal(session.id),
          config.compaction,
        );
        const result = await runWithTranscript(session.id, config, signal, permissions, messages);

        const assistantMessage = createAssistantMessage(session.id, config.model);
        Session.addMessage(session.id, assistantMessage);
        addAssistantResultParts(session.id, assistantMessage.id, result);

        await WorkerRun.updateStatus(session.id, runId, "succeeded", {
          endedAt: Date.now(),
          lastMessageId: assistantMessage.id,
        });

        publishEvent(Subagent.Events.WorkerRunCompleted, {
          sessionId: session.id,
          runId,
          status: "succeeded",
        });

        return {
          sessionId: session.id,
          runId,
          output: result.text,
          finishReason: result.finishReason,
        };
      } catch (error) {
        if (await shouldSkipFailureUpdate(session.id, runId)) {
          throw error;
        }

        await WorkerRun.updateStatus(session.id, runId, "failed", {
          endedAt: Date.now(),
        });
        publishEvent(Subagent.Events.WorkerRunFailed, {
          sessionId: session.id,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        clearRunTimeouts(timers);
        try {
          await finalizeRun(session.id, runId);
        } catch {
          // cleanup must not mask the original error
        }
        removeAbortController(session.id, runId);
      }
    });
  }

  export interface ResumeConfig extends RuntimeConfig {
    sessionId: string;
  }

  export interface ResumeResult {
    resumed: boolean;
    sessionId: string;
    runId: string | undefined;
    output?: string;
    finishReason?: RunResult["finishReason"];
  }

  export interface CancelConfig {
    sessionId: string;
    runId?: string;
    hardTimeoutMs?: number;
  }

  export async function resume(config: ResumeConfig): Promise<ResumeResult> {
    const session = Session.get(config.sessionId);
    if (!session) {
      return { resumed: false, sessionId: config.sessionId, runId: undefined };
    }

    return sendToMailbox(config.sessionId, async () => {
      const runs = await WorkerRun.listBySession(config.sessionId);
      const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;

      if (latestRun?.status === "running" || latestRun?.status === "starting") {
        throw new Error("Session already has an active run");
      }

      const runId = crypto.randomUUID();
      const title = latestRun?.title ?? "resumed";
      const prompt = latestRun?.prompt ?? "resume";

      await WorkerRun.create(config.sessionId, { runId, title, prompt });
      await WorkerRun.updateStatus(config.sessionId, runId, "starting");

      publishEvent(Subagent.Events.WorkerSessionResumed, {
        sessionId: config.sessionId,
        runId,
      });

      try {
        await WorkerRun.updateStatus(config.sessionId, runId, "running");
        const result = await runWithTranscript(config.sessionId, config);

        const assistantMessage = createAssistantMessage(config.sessionId, config.model);
        Session.addMessage(config.sessionId, assistantMessage);
        addAssistantResultParts(config.sessionId, assistantMessage.id, result);

        await WorkerRun.updateStatus(config.sessionId, runId, "succeeded", {
          endedAt: Date.now(),
          lastMessageId: assistantMessage.id,
        });

        publishEvent(Subagent.Events.WorkerRunCompleted, {
          sessionId: config.sessionId,
          runId,
          status: "succeeded",
        });

        return {
          resumed: true,
          sessionId: config.sessionId,
          runId,
          output: result.text,
          finishReason: result.finishReason,
        };
      } catch (error) {
        if (await shouldSkipFailureUpdate(config.sessionId, runId)) {
          throw error;
        }

        await WorkerRun.updateStatus(config.sessionId, runId, "failed", {
          endedAt: Date.now(),
        });
        publishEvent(Subagent.Events.WorkerRunFailed, {
          sessionId: config.sessionId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        try {
          await finalizeRun(config.sessionId, runId);
        } catch {
          // cleanup must not mask the original error
        }
        removeAbortController(config.sessionId, runId);
      }
    });
  }

  export async function cancel(config: CancelConfig): Promise<void> {
    const session = Session.get(config.sessionId);
    if (!session) return;

    const hardTimeoutMs = config.hardTimeoutMs ?? 10_000;

    if (config.runId) {
      const entry = getAbortEntry(config.sessionId, config.runId);
      const hasInFlightOp = !!entry;

      if (hasInFlightOp) {
        entry.controller.abort();
        await raceAbortCompletion(config.sessionId, config.runId, hardTimeoutMs);
      } else {
        const run = await WorkerRun.get(config.sessionId, config.runId);
        if (run && !isTerminalStatus(run.status)) {
          await WorkerRun.updateStatus(config.sessionId, config.runId, "cancelled", {
            endedAt: Date.now(),
          });
        }
      }

      publishEvent(Subagent.Events.WorkerSessionCancelled, {
        sessionId: config.sessionId,
        runId: config.runId,
      });
      return;
    }

    const runs = await WorkerRun.listBySession(config.sessionId);
    const activeRun = runs.find((r) => r.status === "running" || r.status === "starting");
    const abortEntry = activeRun ? getAbortEntry(config.sessionId, activeRun.runId) : undefined;

    if (abortEntry) {
      abortEntry.controller.abort();
    }

    if (activeRun) {
      if (abortEntry) {
        await raceAbortCompletion(config.sessionId, activeRun.runId, hardTimeoutMs);
      } else {
        await WorkerRun.updateStatus(config.sessionId, activeRun.runId, "cancelled", {
          endedAt: Date.now(),
        });
      }
    }

    publishEvent(Subagent.Events.WorkerSessionCancelled, {
      sessionId: config.sessionId,
      runId: activeRun?.runId,
    });
  }

  export async function wait(config: WaitConfig): Promise<WaitResult> {
    const run = await WorkerRun.get(config.sessionId, config.runId);
    if (!run) {
      throw new Error(`Worker run ${config.runId} not found in session ${config.sessionId}`);
    }

    const terminalStatuses = ["succeeded", "failed", "cancelled", "interrupted"] as const;
    if (terminalStatuses.includes(run.status as (typeof terminalStatuses)[number])) {
      return getWaitResult(run);
    }

    return new Promise<WaitResult>((resolve, reject) => {
      let settled = false;
      let unsubscribeCompleted: (() => void) | undefined;
      let unsubscribeFailed: (() => void) | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        unsubscribeCompleted?.();
        unsubscribeFailed?.();
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };

      const settle = async () => {
        if (settled) return;
        settled = true;
        cleanup();
        const finalRun = await WorkerRun.get(config.sessionId, config.runId);
        if (finalRun) {
          resolve(getWaitResult(finalRun));
        } else {
          reject(new Error(`Worker run ${config.runId} disappeared during wait`));
        }
      };

      unsubscribeCompleted = Bus.subscribe(Subagent.Events.WorkerRunCompleted, (data) => {
        if (data.payload.sessionId === config.sessionId && data.payload.runId === config.runId) {
          settle();
        }
      });

      unsubscribeFailed = Bus.subscribe(Subagent.Events.WorkerRunFailed, (data) => {
        if (data.payload.sessionId === config.sessionId && data.payload.runId === config.runId) {
          settle();
        }
      });

      if (config.timeoutMs) {
        timeoutHandle = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`wait() timeout exceeded after ${config.timeoutMs}ms`));
          }
        }, config.timeoutMs);
      }
    });
  }

  function getWaitResult(run: WorkerRunRecord): WaitResult {
    let output: string | undefined;
    if (run.lastMessageId) {
      const parts = Session.getParts(run.lastMessageId);
      output = parts.find((part): part is Message.TextPart => part.type === "text")?.text;
    }

    return {
      status: run.status,
      output,
    };
  }

  export function buildChildMessages(sessionId: string, repair?: boolean): RuntimeMessage[] {
    return buildChildMessagesInternal(sessionId, repair);
  }
}
