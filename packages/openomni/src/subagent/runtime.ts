import type { ChatAgent } from "@openomni/agent";
import { PolicyDecision, type Policy, Subagent } from "@openomni/protocol";
import { Session, WorkerRun, type WorkerRunRecord } from "@openomni/session";
import { register as registerAbortController } from "./abort-registry";
import { SubagentSpawnPolicyMiddleware } from "./middleware/subagent-spawn-policy.js";
import {
  applyPreDelegationDecision,
  buildChildRunMiddleware,
  dispatchPreDelegation,
  hasExplicitRuntimePolicy,
  summarizeChildRuntimeAdmission,
} from "./runtime-admission";
import { cancelRuntimeRun } from "./runtime-cancel";
import { waitForRuntimeRun } from "./runtime-wait";
import { buildAbortSignal, executeRun, setupRunTimeouts } from "./run-lifecycle";
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

interface SpawnConfig extends RuntimeConfig {
  parentSessionId?: string;
  agentName: string;
  title: string;
  prompt: string;
  category?: string;
  signal?: AbortSignal;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  permissions?: Policy.Permission;
}

interface SendConfig extends RuntimeConfig {
  sessionId: string;
  prompt: string;
  signal?: AbortSignal;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  permissions?: Policy.Permission;
  compaction?: SendCompactionConfig;
}

interface WaitConfig {
  sessionId: string;
  runId: string;
  timeoutMs?: number;
}

interface RunResult {
  sessionId: string;
  runId: string;
  output: string;
  finishReason: Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>["finishReason"];
}

interface SpawnBackgroundResult {
  sessionId: string;
  runId: string;
}

interface WaitResult {
  status: WorkerRunRecord["status"];
  output?: string;
}

interface ResumeConfig extends RuntimeConfig {
  sessionId: string;
}

interface ResumeResult {
  resumed: boolean;
  sessionId: string;
  runId: string | undefined;
  output?: string;
  finishReason?: RunResult["finishReason"];
}

interface CancelConfig {
  sessionId: string;
  runId?: string;
  hardTimeoutMs?: number;
}

export namespace SubagentRuntime {
  export async function spawn(config: SpawnConfig): Promise<RunResult> {
    const hasExplicitChildRuntimePolicy = hasExplicitRuntimePolicy(config);
    const decision = await dispatchPreDelegation({
      middleware: config.middleware,
      childAgent: config.agentName,
      parentSessionId: config.parentSessionId,
      operation: "spawn",
      prompt: config.prompt,
      childRuntime: summarizeChildRuntimeAdmission(config),
    });
    applyPreDelegationDecision(config, decision, "invoke.prepare policy aborted spawn");

    const session = createSpawnSession(config);

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
      await WorkerRun.updateStatus(session.id, runId, "running");
      const middleware = buildChildRunMiddleware(config, hasExplicitChildRuntimePolicy);
      const runConfig = { ...config, middleware };
      const result = await executeRun(session.id, runId, config.model, timers, () =>
        runWithTranscript(session.id, runConfig, signal),
      );
      return result;
    });
  }

  export async function spawnBackground(config: SpawnConfig): Promise<SpawnBackgroundResult> {
    const hasExplicitChildRuntimePolicy = hasExplicitRuntimePolicy(config);
    const decision = await dispatchPreDelegation({
      middleware: config.middleware,
      childAgent: config.agentName,
      parentSessionId: config.parentSessionId,
      operation: "spawn_background",
      prompt: config.prompt,
      childRuntime: summarizeChildRuntimeAdmission(config),
    });
    applyPreDelegationDecision(config, decision, "invoke.prepare policy aborted background spawn");

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
    await WorkerRun.updateStatus(session.id, runId, "running");

    const middleware = buildChildRunMiddleware(config, hasExplicitChildRuntimePolicy);
    const runConfig = { ...config, middleware };
    const backgroundRun = sendToMailbox(session.id, () =>
      executeRun(session.id, runId, config.model, timers, () =>
        runWithTranscript(session.id, runConfig, signal),
      ),
    );
    backgroundRun.catch(() => {
      // no-op
    });

    return { sessionId: session.id, runId };
  }

  export async function send(config: SendConfig): Promise<RunResult> {
    const hasExplicitChildRuntimePolicy = hasExplicitRuntimePolicy(config);
    const childMeta = Session.getWorkerMeta(config.sessionId);
    const childAgent =
      typeof childMeta?.agentName === "string" ? childMeta.agentName : config.sessionId;
    const childSession = Session.get(config.sessionId);
    const sendDecision = await dispatchPreDelegation({
      middleware: config.middleware,
      childAgent,
      parentSessionId: childSession?.parentSessionId,
      operation: "send",
      prompt: config.prompt,
      childRuntime: summarizeChildRuntimeAdmission(config),
    });
    applyPreDelegationDecision(config, sendDecision, "invoke.prepare policy aborted send");

    const policy = await SubagentSpawnPolicyMiddleware.runPreSpawn({
      operation: "send",
      sessionId: config.sessionId,
    });
    const session = policy.session;
    if (!session) throw new Error(`Session not found: ${config.sessionId}`);

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

      const middleware = buildChildRunMiddleware(config, hasExplicitChildRuntimePolicy);
      const runConfig = { ...config, middleware };
      const messages = await maybeCompactSendTranscript(
        session.id,
        buildChildMessagesInternal(session.id),
        config.compaction,
      );
      return executeRun(session.id, runId, config.model, timers, () =>
        runWithTranscript(session.id, runConfig, signal, messages),
      );
    });
  }

  export async function resume(config: ResumeConfig): Promise<ResumeResult> {
    return sendToMailbox(config.sessionId, async () => {
      const policy = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
        operation: "resume",
        sessionId: config.sessionId,
      });
      if (PolicyDecision.isBlocking(policy.verdict)) {
        if (PolicyDecision.reason(policy.verdict) === `Session not found: ${config.sessionId}`) {
          return { resumed: false, sessionId: config.sessionId, runId: undefined };
        }
        throw new Error(PolicyDecision.reason(policy.verdict, "subagent resume policy aborted"));
      }

      const latestRun = policy.latestRun;

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
      const runConfig = {
        ...config,
        middleware: buildChildRunMiddleware(config),
      };
      const result = await executeRun(config.sessionId, runId, config.model, undefined, () =>
        runWithTranscript(config.sessionId, runConfig, signal),
      );
      return { resumed: true, ...result };
    });
  }

  export async function cancel(config: CancelConfig): Promise<void> {
    return cancelRuntimeRun(config);
  }

  export async function wait(config: WaitConfig): Promise<WaitResult> {
    return waitForRuntimeRun(config);
  }

  export function buildChildMessages(sessionId: string, repair?: boolean): RuntimeMessage[] {
    return buildChildMessagesInternal(sessionId, repair);
  }
}
