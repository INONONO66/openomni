import {
  PolicyEngine,
  createToolPermissionPolicy,
  type ChatAgent,
  type PolicyContext,
  type PolicyRegistration,
} from "@openomni/agent";
import {
  PolicyDecision,
  type Policy,
  type Message,
  Subagent,
  type RuntimeResource,
} from "@openomni/protocol";
import { Bus, Session, WorkerRun, type WorkerRunRecord } from "@openomni/session";
import {
  buildAgentLifecycleMiddleware,
  registrationsAbsentFrom,
} from "../execution-runtime/middleware.js";
import { get as getAbortEntry, register as registerAbortController } from "./abort-registry";
import { SubagentSpawnPolicyMiddleware } from "./middleware/subagent-spawn-policy.js";
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

const emptyDelegationUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type ResourcePolicyContext = Omit<PolicyContext, "timing"> & {
  readonly resourceDescriptor: RuntimeResource.Descriptor;
};

type PreDelegationOperation = "spawn" | "spawn_background" | "send";

function createDelegationTrace(parentSessionId: string | undefined) {
  if (parentSessionId === undefined) return undefined;
  return { traceId: crypto.randomUUID(), sessionId: parentSessionId };
}

function createSubagentDescriptor(
  childAgent: string,
  operation: PreDelegationOperation,
): RuntimeResource.Descriptor {
  if (operation === "send") {
    return {
      id: "worker:agent:subagent_send",
      kind: "worker",
      source: { type: "agent", agentId: childAgent },
      labels: ["source.agent", "delegation.subagent"],
      capabilities: ["delegation.send"],
      effects: ["session.message"],
    };
  }

  if (operation === "spawn_background") {
    return {
      id: "worker:agent:background_launch",
      kind: "worker",
      source: { type: "agent", agentId: childAgent },
      labels: ["source.agent", "delegation.background"],
      capabilities: ["delegation.background"],
      effects: ["session.create"],
    };
  }

  return {
    id: "worker:agent:subagent_spawn",
    kind: "worker",
    source: { type: "agent", agentId: childAgent },
    labels: ["source.agent", "delegation.subagent"],
    capabilities: ["delegation.spawn"],
    effects: ["session.create"],
  };
}

async function dispatchPreDelegation(input: {
  middleware?: PolicyRegistration[];
  childAgent: string;
  parentSessionId?: string;
  operation: PreDelegationOperation;
  prompt: string;
}): Promise<Policy.PolicyDecision> {
  if (!input.middleware?.length) {
    return PolicyDecision.allow({
      policyId: "subagent.delegation",
      reasonCodes: ["no middleware registered"],
    });
  }

  const traceContext = createDelegationTrace(input.parentSessionId);
  const engine = PolicyEngine.create({
    traceContext,
    audit:
      traceContext === undefined
        ? false
        : {
            sessionId: traceContext.sessionId,
            action: `delegation.${input.operation}`,
            resource: `agent.${input.childAgent}`,
          },
  });
  for (const reg of input.middleware) {
    engine.register(reg);
  }

  const resourceDescriptor = createSubagentDescriptor(input.childAgent, input.operation);
  const policyContext: ResourcePolicyContext = {
    steps: [],
    usage: emptyDelegationUsage,
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    toolName: "subagent",
    toolLabels: resourceDescriptor.labels,
    toolInput: {
      operation: input.operation,
      childAgent: input.childAgent,
      prompt: input.prompt,
      ...(input.parentSessionId !== undefined && { parentSessionId: input.parentSessionId }),
    },
    labels: [
      { value: `actor.child:${input.childAgent}`, source: "system" as const },
      ...(input.parentSessionId !== undefined
        ? [{ value: `actor.parent:${input.parentSessionId}`, source: "system" as const }]
        : []),
    ],
    resourceDescriptor,
    traceContext,
  };

  return engine.dispatch("invoke.prepare", policyContext);
}

function applyDelegationConstraints(
  config: { permissions?: Policy.Permission; softTimeoutMs?: number; hardTimeoutMs?: number },
  decision: Policy.PolicyDecision,
): void {
  const constraints = decision.effects
    .filter(
      (effect): effect is Extract<Policy.PolicyEffect, { type: "delegation.set_constraints" }> =>
        effect.type === "delegation.set_constraints",
    )
    .at(-1)?.constraints;

  if (!constraints) return;
  const permissions = constraints.permissions;
  if (permissions && typeof permissions === "object" && "action" in permissions) {
    config.permissions = permissions as Policy.Permission;
  }
  if (typeof constraints.softTimeoutMs === "number")
    config.softTimeoutMs = constraints.softTimeoutMs;
  if (typeof constraints.hardTimeoutMs === "number")
    config.hardTimeoutMs = constraints.hardTimeoutMs;
}

function applyPreDelegationDecision(
  config: { permissions?: Policy.Permission; softTimeoutMs?: number; hardTimeoutMs?: number },
  decision: Policy.PolicyDecision,
  fallbackReason: string,
): void {
  if (PolicyDecision.isBlocking(decision)) {
    throw new Error(PolicyDecision.reason(decision, fallbackReason));
  }
  applyDelegationConstraints(config, decision);
}

function buildChildRunMiddleware(config: RuntimeConfig & { permissions?: Policy.Permission }) {
  // Used by spawn/send/resume for the child run itself. Admission still reads
  // config.middleware before this helper, so childMiddleware never participates
  // in the parent-scoped delegation decision.
  const inheritedMiddleware = SubagentSpawnPolicyMiddleware.childMiddleware(
    config.childMiddleware ?? config.middleware,
    config.permissions !== undefined || config.childMiddleware !== undefined,
  );
  const inherited = inheritedMiddleware ?? [];
  return [
    ...registrationsAbsentFrom(buildAgentLifecycleMiddleware(undefined), inherited),
    // Subagent run middleware preserves the prior child-run defaults:
    // budget lifecycle + permission constraints only. Send transcript compaction
    // is handled separately before resume; idle nudge is worker-runtime owned.
    ...(config.permissions ? [createToolPermissionPolicy({ permission: config.permissions })] : []),
    ...inherited,
  ];
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
    permissions?: Policy.Permission;
  }

  export interface SendConfig extends RuntimeConfig {
    sessionId: string;
    prompt: string;
    signal?: AbortSignal;
    softTimeoutMs?: number;
    hardTimeoutMs?: number;
    permissions?: Policy.Permission;
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

  export async function spawn(config: SpawnConfig): Promise<RunResult> {
    const decision = await dispatchPreDelegation({
      middleware: config.middleware,
      childAgent: config.agentName,
      parentSessionId: config.parentSessionId,
      operation: "spawn",
      prompt: config.prompt,
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
      const middleware = buildChildRunMiddleware(config);
      const runConfig = { ...config, middleware };
      const result = await executeRun(session.id, runId, config.model, timers, () =>
        runWithTranscript(session.id, runConfig, signal),
      );
      return result;
    });
  }

  export async function spawnBackground(config: SpawnConfig): Promise<SpawnBackgroundResult> {
    const decision = await dispatchPreDelegation({
      middleware: config.middleware,
      childAgent: config.agentName,
      parentSessionId: config.parentSessionId,
      operation: "spawn_background",
      prompt: config.prompt,
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

    const middleware = buildChildRunMiddleware(config);
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

      const middleware = buildChildRunMiddleware(config);
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
    const policy = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "cancel",
      sessionId: config.sessionId,
      hardTimeoutMs: config.hardTimeoutMs,
    });
    if (PolicyDecision.isBlocking(policy.verdict)) return;
    const session = policy.session;
    if (!session) return;

    const hardTimeoutMs = policy.cancelHardTimeoutMs;

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
    const policy = await SubagentSpawnPolicyMiddleware.runPreSpawn({
      operation: "wait",
      sessionId: config.sessionId,
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

      const unsubscribeCompleted = Bus.subscribe(Subagent.Events.WorkerRunCompleted, (data) => {
        if (data.payload.sessionId === config.sessionId && data.payload.runId === config.runId) {
          settle();
        }
      });

      const unsubscribeFailed = Bus.subscribe(Subagent.Events.WorkerRunFailed, (data) => {
        if (data.payload.sessionId === config.sessionId && data.payload.runId === config.runId) {
          settle();
        }
      });

      const timeoutHandle = SubagentSpawnPolicyMiddleware.enforceWaitTimeout(
        policy.waitTimeoutMs,
        () => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`wait() timeout exceeded after ${config.timeoutMs}ms`));
          }
        },
      );

      function cleanup() {
        unsubscribeCompleted();
        unsubscribeFailed();
        timeoutHandle?.cancel();
      }

      async function settle() {
        if (settled) return;
        settled = true;
        cleanup();
        const finalRun = await WorkerRun.get(config.sessionId, config.runId);
        if (finalRun) {
          resolve(getWaitResult(finalRun));
        } else {
          reject(new Error(`Worker run ${config.runId} disappeared during wait`));
        }
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
