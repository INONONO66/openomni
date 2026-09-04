import { SessionHandleStore } from "@openomni/ledger";
import {
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type ObservationSink,
  SessionGeneration,
  SessionTurn,
} from "@openomni/protocol";

interface SessionTool {
  readonly name: string;
  readonly inputSchema: SessionGeneration.Tool["inputSchema"];
  readonly category: SessionGeneration.ToolCategory;
}

interface SessionSystem {
  readonly preset: string;
  readonly blocks: readonly SessionGeneration.SystemBlock[];
}

export interface SessionCreateOptions {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly role: LedgerSession.Role;
  readonly runner: SessionRunner;
  readonly tools?: readonly SessionTool[];
  readonly system?: Partial<SessionSystem>;
  readonly policyGeneration?: number;
}

interface SessionGetOptions {
  readonly turns?: number;
}

export interface SessionRunnerInput {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly turnId: string;
  readonly resultId: string;
  readonly parentActionId: string | null;
  readonly boundaryActionId: string | null;
  readonly messages: readonly SessionTurn.Message[];
  readonly tools: readonly SessionGeneration.Tool[];
  readonly toolsGeneration: number;
  readonly toolsHash: string;
  readonly system: string;
  readonly systemHash: string;
  readonly policyGeneration: number;
  readonly resumeCount: number;
  readonly signal: AbortSignal;
  readonly boundary: (boundary: SessionTurn.Boundary) => Promise<SessionBoundaryResult>;
}

interface SessionBoundaryResult {
  readonly messages: readonly SessionTurn.Message[];
  readonly interrupted: boolean;
}

export type SessionRunnerResult =
  | {
      readonly kind: "result";
      readonly text: string;
      readonly finishReason?: "stop" | "max-steps" | "stalled";
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
        readonly reasoningTokens?: number;
        readonly cacheReadTokens?: number;
        readonly cacheWriteTokens?: number;
      };
    }
  | { readonly kind: "interrupted"; readonly text?: string }
  | {
      readonly kind: "error";
      readonly text: string;
      readonly cause?: Error;
      readonly reported?: true;
    };

export type SessionRunner = (input: SessionRunnerInput) => Promise<SessionRunnerResult>;

export interface SessionRuntime {
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly processId?: string;
  readonly observations: ObservationSink;
  readonly authorizeConfigure?: SessionHandleStore.ConfigureAuthority;
  readonly scheduleHeartbeat?: (callback: () => void, intervalMs: number) => () => void;
  readonly onHibernate?: (sessionId: string) => void | Promise<void>;
  /**
   * How long `close()` waits for an abort-ignoring runner to settle before
   * detaching. Defaults to the lease TTL: after detaching, the heartbeat stops
   * and the durable lease lapses by TTL instead of being handed off while the
   * runner may still be alive. `0` detaches immediately.
   */
  readonly closeGraceMs?: number;
}

interface SessionToolsHandle {
  add(tools: readonly SessionTool[]): Promise<SessionGeneration.ConfigureReceipt>;
  remove(names: readonly string[]): Promise<SessionGeneration.ConfigureReceipt>;
}

interface SessionSystemBlocksHandle {
  set(
    blocks: readonly SessionGeneration.SystemBlock[],
  ): Promise<SessionGeneration.ConfigureReceipt>;
}

export interface SessionHandle {
  readonly id: string;
  readonly tools: SessionToolsHandle;
  readonly system: { readonly blocks: SessionSystemBlocksHandle };
  prompt(content: string, origin?: Inbox.Origin): Promise<SessionRunnerResult | undefined>;
  interrupt(origin?: Inbox.Origin): Promise<void>;
  resume(origin?: Inbox.Origin): Promise<void>;
  get(options?: SessionGetOptions): SessionTurn.Snapshot;
  watch(options?: SessionGetOptions): SessionTurn.Watch;
  close(): Promise<void>;
}

class SessionLeaseError extends Error {
  constructor(readonly result: Exclude<LedgerSession.LeaseResult, { readonly ok: true }>) {
    super(`session lease ${result.reason}`);
    this.name = "SessionLeaseError";
  }
}

export class SessionCommitError extends Error {
  constructor(readonly result: Exclude<LedgerSession.CommitResult, { readonly ok: true }>) {
    super(`session commit ${result.reason}`);
    this.name = "SessionCommitError";
  }
}

interface SessionController {
  readonly handle: SessionHandle;
  readonly owner: string;
  reconcile(): Promise<SessionRunnerResult | undefined>;
  isRunning(): boolean;
}

interface RegistryEntry {
  readonly runner: SessionRunner;
  readonly controller: SessionController;
}

interface SessionControllerLifecycle {
  reactivate(): SessionHandle;
  release(): void;
}

const registries = new WeakMap<SessionRuntime, SessionRegistry>();

export function session(options: SessionCreateOptions, runtime: SessionRuntime): SessionHandle {
  let registry = registries.get(runtime);
  if (registry === undefined) {
    registry = new SessionRegistry(runtime);
    registries.set(runtime, registry);
  }
  return registry.declare(options);
}

export async function sweepSessions(
  resolveRunner: (row: LedgerSession.Row) => SessionRunner,
  runtime: SessionRuntime,
): Promise<void> {
  let registry = registries.get(runtime);
  if (registry === undefined) {
    registry = new SessionRegistry(runtime);
    registries.set(runtime, registry);
  }
  await registry.sweep(resolveRunner);
}

export async function closeSessions(runtime: SessionRuntime): Promise<void> {
  const registry = registries.get(runtime);
  if (registry === undefined) return;
  registries.delete(runtime);
  await registry.close();
}

class SessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private swept = false;
  private closed = false;

  constructor(private readonly runtime: SessionRuntime) {}

  declare(options: SessionCreateOptions): SessionHandle {
    if (this.closed) throw new Error("session registry is closed");
    const entropy = this.runtime.entropy ?? (() => crypto.randomUUID());
    const id = options.id ?? entropy();
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.runner !== options.runner) {
        throw new Error(`session ${id} is already bound to a different runner`);
      }
      return existing.controller.handle;
    }
    const tools = (options.tools ?? []).map(toolSnapshot);
    const materialized = SessionHandleStore.materialize({
      id,
      parentId: options.parentId ?? null,
      role: options.role,
      tools,
      system: {
        preset: options.system?.preset ?? "",
        blocks: options.system?.blocks ?? [],
      },
      policyGeneration: options.policyGeneration ?? SessionHandleStore.currentPolicyGeneration(),
      actionId: entropy(),
      at: (this.runtime.clock ?? Date.now)(),
    });
    if (!materialized.created) {
      assertDeclaration(materialized.row, options, tools, options.system);
    }
    return this.install(id, options.runner).controller.handle;
  }

  async sweep(resolveRunner: (row: LedgerSession.Row) => SessionRunner): Promise<void> {
    if (this.swept) return;
    this.swept = true;
    for (const row of SessionHandleStore.listRows()) {
      const hasOpenTurn = SessionHandleStore.openTurns(SessionHandleStore.tree(row.id)).length > 0;
      const hasInbox = SessionHandleStore.pendingInbox(row.id).length > 0;
      if (!hasOpenTurn && !hasInbox) continue;
      const entry = this.entries.get(row.id) ?? this.install(row.id, resolveRunner(row));
      await entry.controller.reconcile();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.controller.handle.close()));
  }

  private install(id: string, runner: SessionRunner): RegistryEntry {
    if (this.closed) throw new Error("session registry is closed");
    const existing = this.entries.get(id);
    if (existing !== undefined) return existing;
    let controller: SessionController | undefined;
    const lifecycle: SessionControllerLifecycle = {
      reactivate: () => this.install(id, runner).controller.handle,
      release: () => {
        const entry = this.entries.get(id);
        if (controller !== undefined && entry?.controller === controller) this.entries.delete(id);
      },
    };
    controller = createController(id, runner, this.runtime, lifecycle);
    const entry = { runner, controller };
    this.entries.set(id, entry);
    return entry;
  }
}

function createController(
  sessionId: string,
  runner: SessionRunner,
  runtime: SessionRuntime,
  lifecycle: SessionControllerLifecycle,
): SessionController {
  const clock = runtime.clock ?? Date.now;
  const entropy = runtime.entropy ?? (() => crypto.randomUUID());
  const owner = `${runtime.processId ?? String(process.pid)}:${entropy()}`;
  const scheduleHeartbeat = runtime.scheduleHeartbeat ?? defaultHeartbeat;
  let active: Promise<SessionRunnerResult | undefined> | undefined;
  let controller: AbortController | undefined;
  let fence = SessionHandleStore.row(sessionId).leaseFence;
  let closed = false;
  let released = false;
  let successor: SessionHandle | undefined;
  let stopHeartbeat: (() => void) | undefined;
  // Set while a runner that ignored its abort is still alive after the
  // interrupted terminal was sealed. It still holds the durable lease.
  let liveInterruptRunner: Promise<SessionRunnerResult> | undefined;
  // Set when close() gave up waiting for that runner: the lease is left to
  // lapse by TTL and the runner's eventual settlement must not touch it.
  let forceDetached = false;

  function replacement(): SessionHandle | undefined {
    if (closed) throw new Error(`session handle is closed: ${sessionId}`);
    if (!released) return undefined;
    successor ??= lifecycle.reactivate();
    return successor;
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
      if (closed) return;
      closed = true;
      if (released) {
        await successor?.close();
        return;
      }
      controller?.abort();
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
        const settled = active?.then(
          () => "settled" as const,
          () => "settled" as const,
        );
        const outcome = settled === undefined ? "settled" : await Promise.race([settled, grace]);
        if (outcome === "grace") forceDetached = true;
      } finally {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        stopHeartbeat?.();
        stopHeartbeat = undefined;
        released = true;
        lifecycle.release();
      }
    },
  };

  async function enqueue(
    kind: Inbox.Kind,
    content: string,
    origin: Inbox.Origin,
  ): Promise<SessionRunnerResult | undefined> {
    if (closed) throw new Error(`session handle is closed: ${sessionId}`);
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
    if (kind === "interrupt" && current.state === "running") controller?.abort();
    if (kind === "resume" && current.state === "running") return undefined;
    return reconcile();
  }

  async function reconcile(): Promise<SessionRunnerResult | undefined> {
    if (closed || released || active !== undefined) return active;
    const work = driveAvailable().finally(async () => {
      active = undefined;
      await hibernate(SessionHandleStore.row(sessionId));
    });
    active = work;
    return work;
  }

  async function driveAvailable(): Promise<SessionRunnerResult | undefined> {
    let result: SessionRunnerResult | undefined;
    for (;;) {
      if (closed) return result;
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

  async function startTurn(): Promise<SessionRunnerResult | undefined> {
    const current = SessionHandleStore.row(sessionId);
    fence = acquire(current.leaseFence);
    const actions = SessionHandleStore.tree(sessionId);
    const generation = SessionHandleStore.latestGeneration(actions);
    const pending = SessionHandleStore.pendingInbox(sessionId);
    const resultId = entropy();
    const turnId = entropy();
    const parentActionId = actions.at(-1)?.id ?? null;
    const deliveries = deliveryActions(pending, turnId, "before_llm", parentActionId);
    const envelope = turnIntentAction({
      id: turnId,
      parentId: deliveries.at(-1)?.id ?? parentActionId,
      sessionId,
      resultId,
      inboxIds: pending.map((item) => item.id),
      generation,
      resumeCount: 0,
      boundaryActionId: parentActionId,
      at: clock(),
    });
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [...deliveries, envelope],
      consumeInboxIds: pending.map((item) => item.id),
      state: "running",
      releaseLease: false,
    });
    requireCommit(committed);
    if (pending.some((item) => item.kind === "interrupt")) {
      const action = SessionHandleStore.tree(sessionId).find((item) => item.id === turnId);
      if (action === undefined) throw new Error(`committed turn is missing: ${turnId}`);
      const interrupted = { kind: "interrupted" as const };
      await seal(
        {
          turnId,
          resultId,
          resumeCount: 0,
          boundaryActionId: parentActionId,
          toolsGeneration: generation.generation,
          toolsHash: generation.toolsHash,
          systemHash: generation.systemHash,
          policyGeneration: generation.policyGeneration,
          action,
        },
        interrupted,
        true,
      );
      return interrupted;
    }
    return runTurn({
      turnId,
      resultId,
      parentActionId: envelope.id,
      boundaryActionId: parentActionId,
      resumeCount: 0,
      generation,
      resume: false,
    });
  }

  async function resumeTurn(open: SessionHandleStore.OpenTurn): Promise<SessionRunnerResult> {
    if (open.resumeCount >= SessionHandleStore.RESUME_BUDGET) {
      fence = acquire(SessionHandleStore.row(sessionId).leaseFence);
      const exhausted = { kind: "error" as const, text: "session resume budget exhausted" };
      await seal(open, exhausted, true);
      return exhausted;
    }
    const current = SessionHandleStore.row(sessionId);
    fence = acquire(current.leaseFence);
    const generation = generationForOpen(open);
    const resumeCount = open.resumeCount + 1;
    const resumeId = entropy();
    const resultId = open.resultId;
    const resume = turnResumeAction({
      id: resumeId,
      parentId: open.boundaryActionId ?? open.action.id,
      sessionId,
      turnId: open.turnId,
      resultId,
      generation,
      resumeCount,
      boundaryActionId: open.boundaryActionId,
      at: clock(),
    });
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: SessionHandleStore.row(sessionId).revision,
      actions: [resume],
      consumeInboxIds: [],
      state: "running",
      releaseLease: false,
    });
    requireCommit(committed);
    return runTurn({
      turnId: open.turnId,
      resultId,
      parentActionId: resumeId,
      boundaryActionId: open.boundaryActionId,
      resumeCount,
      generation,
      resume: true,
    });
  }

  async function resumeInterrupted(item: Inbox.Row): Promise<SessionRunnerResult | undefined> {
    const terminal = latestTerminal(SessionHandleStore.tree(sessionId));
    if (terminal === undefined) {
      await consumeNoopInbox([item]);
      return undefined;
    }
    const current = SessionHandleStore.row(sessionId);
    fence = acquire(current.leaseFence);
    const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
    const resultId = entropy();
    const turnId = entropy();
    const resumeCount = terminal.effect.resumeCount + 1;
    const delivery = deliveryActions([item], turnId, "before_llm", terminal.action.id);
    const resume = turnIntentAction({
      id: turnId,
      parentId: delivery.at(-1)?.id ?? terminal.action.id,
      sessionId,
      resultId,
      inboxIds: [item.id],
      generation,
      resumeCount,
      boundaryActionId: terminal.effect.boundaryActionId,
      at: clock(),
    });
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [...delivery, resume],
      consumeInboxIds: [item.id],
      state: "running",
      releaseLease: false,
    });
    requireCommit(committed);
    return runTurn({
      turnId,
      resultId,
      parentActionId: resume.id,
      boundaryActionId: terminal.effect.boundaryActionId,
      resumeCount,
      generation,
      resume: true,
    });
  }

  async function runTurn(input: {
    readonly turnId: string;
    readonly resultId: string;
    readonly parentActionId: string;
    readonly boundaryActionId: string | null;
    readonly resumeCount: number;
    readonly generation: SessionGeneration.Snapshot;
    readonly resume: boolean;
  }): Promise<SessionRunnerResult> {
    const row = SessionHandleStore.row(sessionId);
    const turnController = new AbortController();
    controller = turnController;
    stopHeartbeat = scheduleHeartbeat(() => {
      const now = clock();
      const renewed = SessionHandleStore.renewLease({
        sessionId,
        owner,
        fence,
        now,
        expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
      });
      if (!renewed) {
        // The lease was stolen or lapsed: this executor no longer owns the
        // session. Stop renewing at once and abort the runner.
        stopHeartbeat?.();
        stopHeartbeat = undefined;
        turnController.abort();
      }
    }, SessionHandleStore.HEARTBEAT_INTERVAL_MS);
    let parentActionId = input.parentActionId;
    let boundaryActionId = input.boundaryActionId;
    let result: SessionRunnerResult;
    let interruptedRunner: Promise<SessionRunnerResult> | undefined;
    const boundary = async (kind: SessionTurn.Boundary): Promise<SessionBoundaryResult> => {
      const drained = await drainBoundary(
        input.turnId,
        input.resultId,
        kind,
        input.resumeCount,
        parentActionId,
      );
      parentActionId = drained.parentActionId;
      boundaryActionId = drained.boundaryActionId;
      if (drained.interrupted) turnController.abort();
      return { messages: drained.messages, interrupted: drained.interrupted };
    };
    try {
      const aborted = new Promise<SessionRunnerResult>((resolve) => {
        turnController.signal.addEventListener(
          "abort",
          () => resolve({ kind: "interrupted", text: "" }),
          { once: true },
        );
      });
      const running = runner({
        sessionId,
        role: row.role,
        turnId: input.turnId,
        resultId: input.resultId,
        parentActionId,
        boundaryActionId,
        messages: sessionMessages(SessionHandleStore.tree(sessionId)),
        tools: input.generation.tools,
        toolsGeneration: input.generation.generation,
        toolsHash: input.generation.toolsHash,
        system: input.generation.systemValue,
        systemHash: input.generation.systemHash,
        policyGeneration: input.generation.policyGeneration,
        resumeCount: input.resumeCount,
        signal: turnController.signal,
        boundary,
      });
      result = await Promise.race([running, aborted]);
      if (turnController.signal.aborted) {
        interruptedRunner = running;
        if (result.kind !== "interrupted") result = { kind: "interrupted", text: "" };
      }
    } catch (error) {
      result = turnController.signal.aborted
        ? { kind: "interrupted", text: "" }
        : {
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error ? { cause: error } : {}),
          };
    } finally {
      // When the runner ignored the abort and is still alive, keep the heartbeat
      // renewing the durable lease so that no other runtime can acquire it and
      // start a resumed runner; the lease and heartbeat are released only after
      // the runner settles below. Otherwise the runner has settled, so stop now.
      if (interruptedRunner === undefined) {
        stopHeartbeat?.();
        stopHeartbeat = undefined;
      }
      if (controller === turnController) controller = undefined;
    }
    const latestAction = SessionHandleStore.tree(sessionId).at(-1);
    if (latestAction === undefined) throw new Error(`session tree is empty: ${sessionId}`);
    await seal(
      {
        turnId: input.turnId,
        resultId: input.resultId,
        resumeCount: input.resumeCount,
        boundaryActionId,
        toolsGeneration: input.generation.generation,
        toolsHash: input.generation.toolsHash,
        systemHash: input.generation.systemHash,
        policyGeneration: input.generation.policyGeneration,
        action: latestAction,
      },
      result,
      interruptedRunner === undefined,
    );
    if (interruptedRunner !== undefined) {
      // The abort-ignoring runner is still alive and still holds the durable
      // lease (renewed by the heartbeat above). Wait for it to settle, then
      // stop the heartbeat and release the lease so a resume can only start
      // once this executor is genuinely gone — session-wide single flight.
      liveInterruptRunner = interruptedRunner;
      await interruptedRunner.then(
        () => undefined,
        () => undefined,
      );
      liveInterruptRunner = undefined;
      stopHeartbeat?.();
      stopHeartbeat = undefined;
      // If close() already detached, the heartbeat is stopped and the lease
      // lapses by TTL; a release here would race a legitimate new owner.
      if (!forceDetached) await releaseHeldLease();
    }
    return result;
  }

  async function drainBoundary(
    turnId: string,
    resultId: string,
    boundary: SessionTurn.Boundary,
    resumeCount: number,
    parentActionId: string,
  ): Promise<{
    readonly messages: SessionTurn.Message[];
    readonly interrupted: boolean;
    readonly parentActionId: string;
    readonly boundaryActionId: string;
  }> {
    const pending = SessionHandleStore.pendingInbox(sessionId);
    const checkpointId = entropy();
    const deliveries = deliveryActions(pending, turnId, boundary, checkpointId);
    const checkpoint = turnCheckpointAction({
      id: checkpointId,
      parentId: parentActionId,
      sessionId,
      turnId,
      resultId,
      resumeCount,
      boundaryActionId: checkpointId,
      boundary,
      at: clock(),
    });
    const current = SessionHandleStore.row(sessionId);
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [checkpoint, ...deliveries],
      consumeInboxIds: pending.map((item) => item.id),
      state: "running",
      releaseLease: false,
    });
    requireCommit(committed);
    const interrupted = pending.some((item) => item.kind === "interrupt");
    const messages = pending
      .filter((item) => item.kind === "prompt")
      .map((item) => ({ role: "user" as const, text: item.content }));
    return {
      messages,
      interrupted,
      parentActionId: deliveries.at(-1)?.id ?? checkpointId,
      boundaryActionId: checkpointId,
    };
  }

  async function seal(
    open: SessionHandleStore.OpenTurn,
    result: SessionRunnerResult,
    releaseLease: boolean,
  ): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    const actions = SessionHandleStore.tree(sessionId);
    const interrupts =
      result.kind === "interrupted"
        ? SessionHandleStore.pendingInbox(sessionId).filter((item) => item.kind === "interrupt")
        : [];
    const deliveries = deliveryActions(
      interrupts,
      open.turnId,
      "before_llm",
      actions.at(-1)?.id ?? open.action.id,
    );
    const terminal = turnTerminalAction({
      id: open.resultId,
      parentId: deliveries.at(-1)?.id ?? actions.at(-1)?.id ?? open.action.id,
      sessionId,
      turnId: open.turnId,
      result,
      resumeCount: open.resumeCount,
      boundaryActionId: open.boundaryActionId,
      at: clock(),
    });
    const nextState = result.kind === "interrupted" ? "interrupted" : "idle";
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [...deliveries, terminal],
      consumeInboxIds: interrupts.map((item) => item.id),
      state: nextState,
      releaseLease,
    });
    requireCommit(committed);
  }

  async function releaseHeldLease(): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    // Lease already stolen or lapsed: nothing of ours left to release.
    if (current.leaseOwner !== owner || current.leaseFence !== fence) return;
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [],
      consumeInboxIds: [],
      state: current.state,
      releaseLease: true,
    });
    requireCommit(committed);
  }

  async function consumeNoopInbox(items: readonly Inbox.Row[]): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    fence = acquire(current.leaseFence);
    const actions = SessionHandleStore.tree(sessionId);
    const noops = deliveryActions(items, "noop", "before_llm", actions.at(-1)?.id ?? null);
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: noops,
      consumeInboxIds: items.map((item) => item.id),
      state: current.state,
      releaseLease: true,
    });
    requireCommit(committed);
  }

  async function configure(
    operation: SessionGeneration.ConfigureIntent["operation"],
    nextTools: readonly SessionGeneration.Tool[],
    nextSystem: SessionSystem,
  ): Promise<SessionGeneration.ConfigureReceipt> {
    const before = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
    const generation = before.generation + 1;
    const configureAccepted =
      (await runtime.authorizeConfigure?.({
        sessionId,
        role: SessionHandleStore.row(sessionId).role,
        operation,
        generation,
      })) ?? true;
    if (!configureAccepted) {
      throw new SessionGeneration.ConfigureError({
        code: "denied",
        message: `session configure denied: ${operation}`,
      });
    }
    const current = SessionHandleStore.row(sessionId);
    const actions = SessionHandleStore.tree(sessionId);
    const previous = SessionHandleStore.latestGeneration(actions);
    if (previous.generation !== before.generation) {
      throw new SessionGeneration.ConfigureError({
        code: "stale",
        message: `session generation advanced during configure: ${sessionId}`,
      });
    }
    const snapshot = SessionHandleStore.generationSnapshot({
      generation,
      revertTo: previous.generation,
      tools: nextTools,
      system: nextSystem,
      policyGeneration: previous.policyGeneration,
    });
    // This executor holds the live lease while a turn is running AND while an
    // abort-ignoring runner is still alive after its interrupted terminal was
    // sealed. In both cases keep the existing fence and never release: the
    // runner's own settlement path owns the release (session-wide single flight).
    const ownsRunningLease =
      current.leaseOwner === owner &&
      (current.state === "running" || liveInterruptRunner !== undefined);
    fence = ownsRunningLease ? current.leaseFence : acquire(current.leaseFence);
    const configured = SessionHandleStore.configureAction({
      id: entropy(),
      sessionId,
      parentId: actions.at(-1)?.id ?? null,
      operation,
      snapshot,
      at: clock(),
    });
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [configured],
      consumeInboxIds: [],
      state: current.state,
      generation: {
        toolsGeneration: snapshot.generation,
        systemHash: snapshot.systemHash,
        policyGeneration: snapshot.policyGeneration,
      },
      releaseLease: !ownsRunningLease,
    });
    const configuredRow = requireCommit(committed);
    await hibernate(configuredRow);
    return { generation: snapshot.generation, revertTo: snapshot.revertTo };
  }

  function acquire(expectedFence: number): number {
    const now = clock();
    const result = SessionHandleStore.acquireLease({
      sessionId,
      owner,
      expectedFence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    if (!result.ok) throw new SessionLeaseError(result);
    return result.fence;
  }

  async function hibernate(current: LedgerSession.Row): Promise<void> {
    if (released || active !== undefined) return;
    if (current.leaseOwner !== null) return;
    if (SessionHandleStore.pendingInbox(sessionId).length > 0) return;
    released = true;
    lifecycle.release();
    await runtime.onHibernate?.(sessionId);
  }

  return { handle, owner, reconcile, isRunning: () => active !== undefined };
}

function assertDeclaration(
  row: LedgerSession.Row,
  options: SessionCreateOptions,
  tools: readonly SessionGeneration.Tool[],
  system: Partial<SessionSystem> | undefined,
): void {
  if (row.role !== options.role || row.parentId !== (options.parentId ?? null)) {
    throw new Error(`session declaration conflicts with durable identity: ${row.id}`);
  }
  const snapshot = SessionHandleStore.latestGeneration(SessionHandleStore.tree(row.id));
  const expected = SessionHandleStore.generationSnapshot({
    generation: snapshot.generation,
    revertTo: snapshot.revertTo,
    tools,
    system: {
      preset: system?.preset ?? "",
      blocks: system?.blocks ?? [],
    },
    policyGeneration: options.policyGeneration ?? snapshot.policyGeneration,
  });
  if (snapshot.toolsHash !== expected.toolsHash || snapshot.systemHash !== expected.systemHash) {
    throw new Error(`session declaration conflicts with durable generation: ${row.id}`);
  }
}

function generationForOpen(open: SessionHandleStore.OpenTurn): SessionGeneration.Snapshot {
  const snapshot = SessionHandleStore.generationByNumber(
    SessionHandleStore.tree(open.action.sessionId),
    open.toolsGeneration,
  );
  if (
    snapshot === undefined ||
    snapshot.toolsHash !== open.toolsHash ||
    snapshot.systemHash !== open.systemHash ||
    snapshot.policyGeneration !== open.policyGeneration
  ) {
    throw new Error(`pinned session generation unavailable: ${open.toolsGeneration}`);
  }
  return snapshot;
}

function latestTerminal(
  actions: readonly LedgerAction.Node[],
): { readonly action: LedgerAction.Node; readonly effect: SessionTurn.Terminal } | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    const effect = SessionHandleStore.turnTerminal(action);
    if (action !== undefined && effect !== undefined) return { action, effect };
  }
  return undefined;
}

function sessionMessages(actions: readonly LedgerAction.Node[]): SessionTurn.Message[] {
  const messages: SessionTurn.Message[] = [];
  for (const action of actions) {
    const delivered = SessionHandleStore.delivery(action);
    if (delivered?.kind === "prompt") {
      messages.push({ role: "user", text: delivered.content });
    }
    const terminal = SessionHandleStore.turnTerminal(action);
    if (terminal !== undefined && terminal.text.length > 0) {
      messages.push({ role: "assistant", text: terminal.text });
    }
  }
  return messages;
}

function toolSnapshot(tool: SessionTool): SessionGeneration.Tool {
  return SessionGeneration.Tool.parse(tool);
}

function internalOrigin(sessionId: string): Inbox.Origin {
  return { encodingVersion: 1, value: { kind: "session", id: sessionId } };
}

function requireCommit(result: LedgerSession.CommitResult): LedgerSession.Row {
  if (!result.ok) throw new SessionCommitError(result);
  return result.row;
}

interface TurnEnvelopeActionInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly at: number;
}

interface TurnPinnedInput {
  readonly generation: SessionGeneration.Snapshot;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
}

function pinnedTurn(input: TurnPinnedInput): Omit<SessionTurn.Intent, "phase" | "inboxIds"> {
  return {
    resultId: input.resultId,
    toolsGeneration: input.generation.generation,
    toolsHash: input.generation.toolsHash,
    systemHash: input.generation.systemHash,
    policyGeneration: input.generation.policyGeneration,
    resumeCount: input.resumeCount,
    boundaryActionId: input.boundaryActionId,
  };
}

function turnEnvelopeAction(
  input: TurnEnvelopeActionInput,
  intent: SessionTurn.Intent | SessionTurn.Resume,
): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: intent },
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: input.at,
  };
}

function turnIntentAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly resultId: string;
  readonly inboxIds: readonly string[];
  readonly generation: SessionGeneration.Snapshot;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return turnEnvelopeAction(
    input,
    SessionTurn.Intent.parse({
      phase: "intent",
      inboxIds: [...input.inboxIds],
      ...pinnedTurn(input),
    }),
  );
}

function turnResumeAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resultId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return turnEnvelopeAction(
    input,
    SessionTurn.Resume.parse({
      phase: "resume",
      turnId: input.turnId,
      ...pinnedTurn(input),
    }),
  );
}

function turnCheckpointAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string;
  readonly boundary: SessionTurn.Boundary;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "checkpoint", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "checkpoint",
        turnId: input.turnId,
        resultId: input.resultId,
        resumeCount: input.resumeCount,
        boundaryActionId: input.boundaryActionId,
        boundary: input.boundary,
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

function deliveryActions(
  items: readonly Inbox.Row[],
  turnId: string,
  boundary: SessionTurn.Boundary,
  parentId: string | null,
): LedgerAction.Append[] {
  let parent = parentId;
  return items.map((item) => {
    const action: LedgerAction.Append = {
      id: `${item.id}:delivery`,
      parentId: parent,
      sessionId: item.sessionId,
      kind: "inbox.deliver",
      intent: { encodingVersion: 1, value: { inboxId: item.id } },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "delivery",
          turnId,
          inboxId: item.id,
          kind: item.kind,
          content: item.content,
          origin: item.origin,
          boundary,
        },
      },
      irreversible: true,
      ts: item.createdAt,
    };
    parent = action.id;
    return action;
  });
}

function turnTerminalAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly result: SessionRunnerResult;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "terminal",
        turnId: input.turnId,
        kind: input.result.kind,
        text: input.result.text ?? "",
        boundaryActionId: input.boundaryActionId,
        resumeCount: input.resumeCount,
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

function defaultHeartbeat(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  return () => clearInterval(timer);
}
