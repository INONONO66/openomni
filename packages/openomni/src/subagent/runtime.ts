import type { ChatAgent } from "@openomni/agent";
import { type Guardrail, type Message, Subagent } from "@openomni/protocol";
import { Bus, Log, Session, WorkerRun, type WorkerRunRecord } from "@openomni/session";
import { get as getAbortEntry, register as registerAbortController } from "./abort-registry";
import {
  buildAbortSignal,
  executeRun,
  isTerminalStatus,
  raceAbortCompletion,
  setupRunTimeouts,
} from "./run-lifecycle";
import { sendToMailbox } from "./session-mailbox.js";
import {
  type RuntimeMessage,
  addTextPart,
  createSpawnSession,
  createUserMessage,
  publishEvent,
} from "./shared";
import {
  type RuntimeConfig,
  type SendCompactionConfig,
  buildChildMessagesInternal,
  maybeCompactSendTranscript,
  runWithTranscript,
} from "./transcript";

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

  export function spawn(config: SpawnConfig): Promise<RunResult> {
    const session = createSpawnSession(config);
    Log.info("subagent.spawn", {
      agentName: config.agentName,
      sessionId: session.id,
      parentSessionId: config.parentSessionId,
      titleLen: config.title.length,
    });

    return sendToMailbox(session.id, async () => {
      const userMessage = createUserMessage(session.id, config.model);
      Session.addMessage(session.id, userMessage);
      addTextPart(session.id, userMessage.id, config.prompt);

      const runId = crypto.randomUUID();
      await WorkerRun.create(session.id, { runId, title: config.title, prompt: config.prompt });
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

      await WorkerRun.updateStatus(session.id, runId, "running");
      const permissions = config.permissions ?? { denylist: ["subagent"] };
      const result = await executeRun(session.id, runId, config.model, timers, () =>
        runWithTranscript(session.id, config, signal, permissions),
      );
      Log.info("subagent.spawn.complete", {
        agentName: config.agentName,
        sessionId: session.id,
        runId,
      });
      return result;
    });
  }

  export async function spawnBackground(config: SpawnConfig): Promise<SpawnBackgroundResult> {
    const session = createSpawnSession(config);

    const userMessage = createUserMessage(session.id, config.model);
    Session.addMessage(session.id, userMessage);
    addTextPart(session.id, userMessage.id, config.prompt);

    const runId = crypto.randomUUID();
    await WorkerRun.create(session.id, { runId, title: config.title, prompt: config.prompt });
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
    Log.info("subagent.spawn-background", {
      agentName: config.agentName,
      sessionId: session.id,
      runId,
    });

    const permissions = config.permissions ?? { denylist: ["subagent"] };
    const backgroundRun = sendToMailbox(session.id, () =>
      executeRun(session.id, runId, config.model, timers, () =>
        runWithTranscript(session.id, config, signal, permissions),
      ),
    );
    backgroundRun.catch((err) => {
      Log.warn("subagent.spawn-background.failed", {
        sessionId: session.id,
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { sessionId: session.id, runId };
  }

  export function send(config: SendConfig): Promise<RunResult> {
    const session = Session.get(config.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${config.sessionId}`);
    }
    Log.info("subagent.send", { sessionId: config.sessionId });

    return sendToMailbox(session.id, async () => {
      const userMessage = createUserMessage(session.id, config.model);
      Session.addMessage(session.id, userMessage);
      addTextPart(session.id, userMessage.id, config.prompt);

      const runId = crypto.randomUUID();
      await WorkerRun.create(session.id, { runId, title: "retry", prompt: config.prompt });
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

      const permissions = config.permissions ?? { denylist: ["subagent"] };
      const messages = await maybeCompactSendTranscript(
        session.id,
        buildChildMessagesInternal(session.id),
        config.compaction,
      );
      return executeRun(session.id, runId, config.model, timers, () =>
        runWithTranscript(session.id, config, signal, permissions, messages),
      );
    });
  }

  export async function resume(config: ResumeConfig): Promise<ResumeResult> {
    const session = Session.get(config.sessionId);
    if (!session) {
      return { resumed: false, sessionId: config.sessionId, runId: undefined };
    }
    Log.info("subagent.resume", { sessionId: config.sessionId });

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
      const abortEntry = registerAbortController(config.sessionId, runId);
      const signal = buildAbortSignal(abortEntry.controller);
      await WorkerRun.updateStatus(config.sessionId, runId, "starting");

      publishEvent(Subagent.Events.WorkerSessionResumed, {
        sessionId: config.sessionId,
        runId,
      });

      await WorkerRun.updateStatus(config.sessionId, runId, "running");
      const result = await executeRun(config.sessionId, runId, config.model, undefined, () =>
        runWithTranscript(config.sessionId, config, signal),
      );
      return { resumed: true, ...result };
    });
  }

  export async function cancel(config: CancelConfig): Promise<void> {
    const session = Session.get(config.sessionId);
    if (!session) return;
    Log.info("subagent.cancel", { sessionId: config.sessionId, runId: config.runId });

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
    Log.info("subagent.wait", {
      sessionId: config.sessionId,
      runId: config.runId,
      timeoutMs: config.timeoutMs,
    });
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
