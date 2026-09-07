import { SessionHandleStore } from "@openomni/ledger";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { Inbox, LedgerSession } from "@openomni/protocol";
import { ExecutionApprovalError } from "./executor";
import type {
  SessionController,
  SessionControllerLifecycle,
  SessionRuntime,
  SessionRunner,
  SessionRunnerResult,
  SessionHandle,
  SessionToolsHandle,
  SessionSystemBlocksHandle,
} from "./session-contract";
import { toolSnapshot, internalOrigin, requireCommit } from "./session-record";
import type { SessionControllerState } from "./session-controller-state";
import { createSessionTurn } from "./session-turn";
import { createSessionAdmission } from "./session-admission";
import { createSessionConfiguration } from "./session-configuration";

export function createController(
  sessionId: string,
  runner: SessionRunner,
  runtime: SessionRuntime,
  lifecycle: SessionControllerLifecycle,
  pinPolicy: (generation: number) => CompiledPolicySnapshot,
): SessionController {
  const clock = runtime.clock ?? Date.now;
  const entropy = runtime.entropy ?? (() => crypto.randomUUID());
  const owner = `${runtime.processId ?? String(process.pid)}:${entropy()}`;
  const scheduleHeartbeat = runtime.scheduleHeartbeat ?? defaultHeartbeat;
  const state: SessionControllerState = {
    active: undefined,
    controller: undefined,
    fence: SessionHandleStore.row(sessionId).leaseFence,
    closed: false,
    released: false,
    successor: undefined,
    stopHeartbeat: undefined,
    liveInterruptRunner: undefined,
    retainedRunner: undefined,
    retainedFailure: undefined,
    activeApprovals: undefined,
  };

  const { runTurn, seal } = createSessionTurn(
    sessionId,
    runner,
    runtime,
    state,
    owner,
    clock,
    entropy,
    scheduleHeartbeat,
    pinPolicy,
    {
      createExecutionLedger: (...args) => createExecutionLedger(...args),
      evaluatePromptPolicies: (...args) => evaluatePromptPolicies(...args),
      consumePolicyBlockedInbox: (...args) => consumePolicyBlockedInbox(...args),
      releaseHeldLease: (...args) => releaseHeldLease(...args),
      hibernate: (...args) => hibernate(...args),
    },
  );

  const {
    startTurn,
    evaluatePromptPolicies,
    consumePolicyBlockedInbox,
    createExecutionLedger,
    resumeTurn,
    resumeInterrupted,
    consumeNoopInbox,
  } = createSessionAdmission(sessionId, runtime, state, owner, clock, entropy, pinPolicy, {
    awaitRetainedRunner: (...args) => awaitRetainedRunner(...args),
    acquire: (...args) => acquire(...args),
    runTurn: (...args) => runTurn(...args),
    seal: (...args) => seal(...args),
  });

  const { configure, acquire, leaseLive, releaseHeldLease } = createSessionConfiguration(
    sessionId,
    runtime,
    state,
    owner,
    clock,
    entropy,
    {
      hibernate: (...args) => hibernate(...args),
    },
  );

  function replacement(): SessionHandle | undefined {
    if (state.closed) throw new Error(`session handle is closed: ${sessionId}`);
    if (!state.released) return undefined;
    state.successor ??= lifecycle.reactivate();
    return state.successor;
  }

  const tools: SessionToolsHandle = {
    async add(additions) {
      const nextHandle = replacement();
      if (nextHandle !== undefined) return nextHandle.tools.add(additions);
      const current = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
      const next = [...current.tools, ...additions.map(toolSnapshot)];
      return configure("tools.add", next, {
        preset: current.systemPreset,
        blocks: current.systemBlocks,
      });
    },
    async remove(names) {
      const nextHandle = replacement();
      if (nextHandle !== undefined) return nextHandle.tools.remove(names);
      const current = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
      const removed = new Set(names);
      return configure(
        "tools.remove",
        current.tools.filter((tool) => !removed.has(tool.name)),
        { preset: current.systemPreset, blocks: current.systemBlocks },
      );
    },
  };

  const blocks: SessionSystemBlocksHandle = {
    async set(nextBlocks) {
      const nextHandle = replacement();
      if (nextHandle !== undefined) return nextHandle.system.blocks.set(nextBlocks);
      const current = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
      return configure("system.blocks.set", current.tools, {
        preset: current.systemPreset,
        blocks: nextBlocks,
      });
    },
  };
  const handle: SessionHandle = {
    id: sessionId,
    approvals: {
      pending: () => state.activeApprovals?.pending() ?? [],
      async answer(answer) {
        if (state.activeApprovals === undefined) throw new ExecutionApprovalError("stale_approval");
        await state.activeApprovals.answer(answer);
      },
    },
    tools,
    system: { blocks },
    prompt(content, origin = internalOrigin(sessionId)) {
      const nextHandle = replacement();
      return nextHandle === undefined
        ? enqueue("prompt", content, origin)
        : nextHandle.prompt(content, origin);
    },
    async interrupt(origin = internalOrigin(sessionId)) {
      const nextHandle = replacement();
      await (nextHandle === undefined
        ? enqueue("interrupt", "", origin)
        : nextHandle.interrupt(origin));
    },
    async resume(origin = internalOrigin(sessionId)) {
      const nextHandle = replacement();
      await (nextHandle === undefined ? enqueue("resume", "", origin) : nextHandle.resume(origin));
    },
    get: (options = {}) => SessionHandleStore.getSnapshot(sessionId, options.turns ?? 1),
    watch: (options = {}) =>
      SessionHandleStore.watchSnapshot(sessionId, options.turns ?? 1, runtime.observations),
    async close() {
      if (state.closed) return;
      state.closed = true;
      if (state.released) {
        await state.successor?.close();
        return;
      }
      state.controller?.abort();
      const graceMs = runtime.closeGraceMs ?? SessionHandleStore.LEASE_TTL_MS;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"grace">((resolve) => {
        if (graceMs <= 0) {
          resolve("grace");
          return;
        }
        graceTimer = setTimeout(() => resolve("grace"), graceMs);
        graceTimer.unref?.();
      });
      try {
        // Only the caller-facing wait is bounded. When the grace window lapses
        // the turn continuation keeps the heartbeat alive and releases the
        // lease itself once the abort-ignoring runner finally settles, so the
        // lease is never handed off while that runner may still be alive.
        const settled = Promise.all([state.active, state.retainedRunner]).then(
          () => undefined,
          () => undefined,
        );
        await Promise.race([settled, grace]);
      } finally {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        // A still-live turn or retained runner owns the lifecycle release: the
        // drive loop / retained continuation runs `hibernate()` once the lease
        // is actually released (see runTurn).
        if (state.active === undefined && state.retainedRunner === undefined) {
          state.released = true;
          lifecycle.release();
        }
      }
    },
  };

  async function enqueue(
    kind: Inbox.Kind,
    content: string,
    origin: Inbox.Origin,
  ): Promise<SessionRunnerResult | undefined> {
    if (state.closed) throw new Error(`session handle is closed: ${sessionId}`);
    const current = SessionHandleStore.row(sessionId);
    const actions = SessionHandleStore.tree(sessionId);
    SessionHandleStore.commitInbox({
      id: entropy(),
      sessionId,
      kind,
      content,
      origin,
      createdAt: clock(),
      parentActionId: actions.at(-1)?.id ?? null,
    });
    if (kind === "interrupt" && current.state === "running") {
      try {
        const interrupted = SessionHandleStore.row(sessionId);
        const committed = SessionHandleStore.commit({
          sessionId,
          owner,
          fence: state.fence,
          now: clock(),
          expectedRevision: interrupted.revision,
          actions: [],
          consumeInboxIds: [],
          state: "interrupted",
          releaseLease: false,
        });
        requireCommit(committed);
      } finally {
        state.controller?.abort();
      }
    }
    if (kind === "resume" && current.state === "running") return undefined;
    return reconcile();
  }

  async function reconcile(): Promise<SessionRunnerResult | undefined> {
    if (SessionHandleStore.pendingInbox(sessionId).some((item) => item.kind === "interrupt")) {
      state.controller?.abort();
    }
    if (state.closed || state.released || state.active !== undefined) return state.active;
    const work = driveAvailable().finally(async () => {
      state.active = undefined;
      await hibernate(SessionHandleStore.row(sessionId));
    });
    state.active = work;
    return work;
  }

  async function driveAvailable(): Promise<SessionRunnerResult | undefined> {
    let result: SessionRunnerResult | undefined;
    for (;;) {
      if (state.closed) return result;
      const actions = SessionHandleStore.tree(sessionId);
      const open = SessionHandleStore.openTurns(actions).at(-1);
      if (open !== undefined) {
        result = await resumeTurn(open);
        continue;
      }
      const pending = SessionHandleStore.pendingInbox(sessionId);
      if (pending.length === 0) return result;
      const current = SessionHandleStore.row(sessionId);
      if (current.state === "interrupted") {
        const resume = pending.find((item) => item.kind === "resume");
        if (resume === undefined) return result;
        result = await resumeInterrupted(resume);
        continue;
      }
      const firstPrompt = pending.findIndex((item) => item.kind === "prompt");
      if (firstPrompt > 0) {
        await consumeNoopInbox(pending.slice(0, firstPrompt));
        continue;
      }
      if (firstPrompt === 0) {
        result = await startTurn();
        continue;
      }
      await consumeNoopInbox(pending);
    }
  }

  async function awaitRetainedRunner(): Promise<void> {
    while (state.retainedRunner !== undefined) await state.retainedRunner;
    if (state.retainedFailure !== undefined) {
      const failure = state.retainedFailure;
      state.retainedFailure = undefined;
      throw failure;
    }
  }

  async function hibernate(current: LedgerSession.Row): Promise<void> {
    if (state.released || state.active !== undefined) return;
    if (leaseLive(current)) return;
    if (SessionHandleStore.pendingInbox(sessionId).length > 0) return;
    state.released = true;
    lifecycle.release();
    await runtime.onHibernate?.(sessionId);
  }

  return { handle, owner, reconcile, isRunning: () => state.active !== undefined };
}

function defaultHeartbeat(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
