import { ChatAgent, type ChatAgentConfig } from "@openomni/agent";
import { type Message, Subagent, type Tool } from "@openomni/protocol";
import { Bus, type BusEvent, Session, WorkerRun, type WorkerRunRecord } from "@openomni/session";
import {
  get as getAbortEntry,
  register as registerAbortController,
  remove as removeAbortController,
} from "./abort-registry";

const sessionLocks = new Map<string, Promise<void>>();

// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional noop for promise chain error swallowing
const noop = () => {};

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn);
  const tail = next.then(noop, noop);
  sessionLocks.set(sessionId, tail);
  tail.then(() => {
    if (sessionLocks.get(sessionId) === tail) {
      sessionLocks.delete(sessionId);
    }
  });
  return next;
}

type RuntimeModel = { provider: string; id: string };

type RuntimeMessage = { role: "user" | "assistant"; content: string };

type RuntimeConfig = {
  model: RuntimeModel;
  systemPrompt?: string;
  tools?: ChatAgentConfig["tools"];
  toolExecutor?: ChatAgentConfig["toolExecutor"];
  budget?: ChatAgentConfig["budget"];
};

function toSessionModel(model: RuntimeModel): { providerID: string; modelID: string } {
  return {
    providerID: model.provider,
    modelID: model.id,
  };
}

function createUserMessage(sessionId: string, model: RuntimeModel): Message.UserMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent: "subagent-runtime",
    model: toSessionModel(model),
  };
}

function createAssistantMessage(sessionId: string, model: RuntimeModel): Message.AssistantMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: model.id,
    providerID: model.provider,
    agent: "subagent-runtime",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function addTextPart(sessionId: string, messageId: string, text: string): void {
  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
  };
  Session.addPart(messageId, part);
}

function createCompletedToolState(call: Tool.Call, output: string): Tool.StateCompleted {
  const now = Date.now();
  return {
    status: "completed",
    input: call.input,
    output,
    title: call.tool,
    metadata: {},
    time: {
      start: now,
      end: now,
    },
  };
}

function addToolParts(
  sessionId: string,
  messageId: string,
  steps: { toolCalls?: Tool.Call[]; toolResults?: Tool.Result[] }[],
): void {
  for (const step of steps) {
    if (!step.toolCalls || !step.toolResults) {
      continue;
    }

    const resultsByCallId = new Map(step.toolResults.map((result) => [result.toolCallId, result]));
    for (const call of step.toolCalls) {
      const result = resultsByCallId.get(call.id);
      if (!result) {
        continue;
      }

      const part: Message.ToolPart = {
        id: crypto.randomUUID(),
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        callID: call.id,
        tool: call.tool,
        state: createCompletedToolState(call, result.output),
      };
      Session.addPart(messageId, part);
    }
  }
}

function serializeToolPart(part: Message.ToolPart, repair?: boolean): string {
  const input = JSON.stringify(part.state.input);

  switch (part.state.status) {
    case "completed":
      return `[Tool: ${part.tool}] Input: ${input} Output: ${part.state.output}`;
    case "error":
      return `[Tool: ${part.tool}] Input: ${input} Output: ${part.state.error}`;
    case "pending":
    case "running":
      if (repair) {
        return `[Tool: ${part.tool}] Error: tool execution interrupted (synthetic)`;
      }
      return `[Tool: ${part.tool}] Input: ${input} Output: (${part.state.status})`;
  }
}

function addAssistantResultParts(
  sessionId: string,
  messageId: string,
  result: Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>,
): void {
  addTextPart(sessionId, messageId, result.text);
  addToolParts(sessionId, messageId, result.steps);
}

function publishEvent<TPayload extends { sessionId?: string; runId?: string }>(
  event: BusEvent.Descriptor<{
    traceId: string;
    sessionId?: string;
    runId?: string;
    time: number;
    payload: TPayload;
  }>,
  payload: TPayload,
): void {
  Bus.publish(event, {
    traceId: crypto.randomUUID(),
    sessionId: payload.sessionId,
    runId: payload.runId,
    time: Date.now(),
    payload,
  });
}

function buildChildMessagesInternal(sessionId: string, repair?: boolean): RuntimeMessage[] {
  const messages = Session.getMessages(sessionId);
  const result: RuntimeMessage[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const parts = Session.getParts(message.id);
    const content: string[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        content.push(part.text);
        continue;
      }

      if (part.type === "tool") {
        content.push(serializeToolPart(part, repair));
      }
    }

    if (content.length > 0) {
      result.push({ role: message.role, content: content.join("\n") });
    }
  }

  return result;
}

async function runWithTranscript(
  sessionId: string,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>> {
  const messages = buildChildMessagesInternal(sessionId);
  const agent = ChatAgent.create({
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    budget: config.budget,
    toolExecutor: config.toolExecutor,
    signal,
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
  const entry = getAbortEntry(sessionId);
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

async function waitForAbortEntryRemoval(sessionId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (getAbortEntry(sessionId) === undefined) return;
    await Promise.resolve();
  }
  while (getAbortEntry(sessionId) !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function raceAbortCompletion(
  sessionId: string,
  runId: string,
  hardTimeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortWait = waitForAbortEntryRemoval(sessionId).then(() => "settled" as const);
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), hardTimeoutMs);
  });

  const winner = await Promise.race([abortWait, timeout]);

  if (winner === "timeout") {
    removeAbortController(sessionId);
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

export namespace SubagentRuntime {
  export interface SpawnConfig extends RuntimeConfig {
    parentSessionId?: string;
    agentName: string;
    title: string;
    prompt: string;
    category?: string;
    signal?: AbortSignal;
  }

  export interface SendConfig extends RuntimeConfig {
    sessionId: string;
    prompt: string;
    signal?: AbortSignal;
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

    return withSessionLock(session.id, async () => {
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
      await WorkerRun.updateStatus(session.id, runId, "starting");
      publishEvent(Subagent.Events.WorkerRunStarted, {
        sessionId: session.id,
        runId,
        title: config.title,
      });

      try {
        await WorkerRun.updateStatus(session.id, runId, "running");
        const result = await runWithTranscript(session.id, config, signal);

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
        try {
          await finalizeRun(session.id, runId);
        } catch {
          // cleanup must not mask the original error
        }
        removeAbortController(session.id);
      }
    });
  }

  export function send(config: SendConfig): Promise<RunResult> {
    const session = Session.get(config.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${config.sessionId}`);
    }

    return withSessionLock(session.id, async () => {
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
      await WorkerRun.updateStatus(session.id, runId, "starting");
      await WorkerRun.updateStatus(session.id, runId, "running");

      try {
        const result = await runWithTranscript(session.id, config, signal);

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
        try {
          await finalizeRun(session.id, runId);
        } catch {
          // cleanup must not mask the original error
        }
        removeAbortController(session.id);
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
      addTextPart(config.sessionId, assistantMessage.id, result.text);

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
      removeAbortController(config.sessionId);
    }
  }

  export async function cancel(config: CancelConfig): Promise<void> {
    const session = Session.get(config.sessionId);
    if (!session) return;

    const hardTimeoutMs = config.hardTimeoutMs ?? 10_000;

    if (config.runId) {
      const entry = getAbortEntry(config.sessionId);
      const hasInFlightOp = !!entry && entry.activeRunId === config.runId;

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
    const abortEntry = getAbortEntry(config.sessionId);

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
      let unsubscribeCompleted: (() => void) | undefined;
      let unsubscribeFailed: (() => void) | undefined;
      let pollingInterval: NodeJS.Timeout | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const cleanup = () => {
        unsubscribeCompleted?.();
        unsubscribeFailed?.();
        if (pollingInterval) clearInterval(pollingInterval);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };

      const handleCompletion = async () => {
        cleanup();
        const finalRun = await WorkerRun.get(config.sessionId, config.runId);
        if (finalRun) {
          resolve(getWaitResult(finalRun));
        }
      };

      const handleFailure = async () => {
        cleanup();
        const finalRun = await WorkerRun.get(config.sessionId, config.runId);
        if (finalRun) {
          resolve(getWaitResult(finalRun));
        }
      };

      unsubscribeCompleted = Bus.subscribe(Subagent.Events.WorkerRunCompleted, (data) => {
        if (data.sessionId === config.sessionId && data.runId === config.runId) {
          handleCompletion();
        }
      });

      unsubscribeFailed = Bus.subscribe(Subagent.Events.WorkerRunFailed, (data) => {
        if (data.sessionId === config.sessionId && data.runId === config.runId) {
          handleFailure();
        }
      });

      pollingInterval = setInterval(async () => {
        const currentRun = await WorkerRun.get(config.sessionId, config.runId);
        if (
          currentRun &&
          terminalStatuses.includes(currentRun.status as (typeof terminalStatuses)[number])
        ) {
          cleanup();
          resolve(getWaitResult(currentRun));
        }
      }, 100);

      if (config.timeoutMs) {
        timeoutHandle = setTimeout(() => {
          cleanup();
          reject(new Error(`wait() timeout exceeded after ${config.timeoutMs}ms`));
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
