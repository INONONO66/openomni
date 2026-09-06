import { SessionHandleStore } from "@openomni/ledger";
import { createPolicyCompiler, type CompiledPolicySnapshot } from "@openomni/policy";
import {
  canonicalDigest,
  Deadline,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type ObservationSink,
  type PlainObject,
  type PlainValue,
  SessionGeneration,
  SessionTurn,
} from "@openomni/protocol";
import type { AgentExecutionLifecycle } from "./core/types";
import { RunReasonCode } from "./core/policy/reason-codes";
import {
  createExecutor,
  ExecutionApprovalError,
  type ExecutionApprovals,
  type ExecutorOptions,
} from "./executor";

interface SessionTool {
  readonly name: string;
  readonly inputSchema: SessionGeneration.Tool["inputSchema"];
  readonly category: SessionGeneration.ToolCategory;
  readonly sequential?: true;
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

interface SessionActionCommitPort {
  commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt>;
}

export interface SessionRunnerInput {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly turnId: string;
  readonly actionId: string;
  readonly ledger: SessionActionCommitPort;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly trackWave?: (wave: Promise<void>) => void;
  readonly bindApprovals?: (approvals: ExecutionApprovals) => void;
  readonly policy: CompiledPolicySnapshot;
  readonly execution?: AgentExecutionLifecycle;
  readonly resultId: string;
  readonly parentActionId: string | null;
  readonly boundaryActionId: string | null;
  readonly messages: readonly (SessionTurn.Message & { readonly id?: string })[];
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
  readonly messages: readonly (SessionTurn.Message & { readonly id?: string })[];
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
  readonly approvalTimeoutMs?: ExecutorOptions["approvalTimeoutMs"];
  readonly scheduleApprovalTimeout?: ExecutorOptions["scheduleApprovalTimeout"];
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly processId?: string;
  readonly observations: ObservationSink;
  readonly authorizeConfigure?: SessionHandleStore.ConfigureAuthority;
  readonly authorizeApproval?: ExecutorOptions["authorizeApproval"];
  /**
   * Lease contract. The durable lease is a fenced single-writer guarantee:
   * every commit carries the fence of the executor that owns the lease, so a
   * stale executor can never write after another one took over. Liveness is
   * kept by the heartbeat; when renewal is refused (lease stolen after the TTL
   * elapsed without a heartbeat) the running turn is aborted. A runner MUST
   * honour that abort promptly - an abort-ignoring runner keeps computing
   * without authority; its late result is discarded and it never touches the
   * lease of a later owner. Takeover after an expired TTL is the intended
   * recovery for a dead or stalled executor, not a hand-off. The default
   * heartbeat timer is unref'd so a detached runner never pins the process.
   */
  readonly scheduleHeartbeat?: (callback: () => void, intervalMs: number) => () => void;
  readonly onHibernate?: (sessionId: string) => void | Promise<void>;
  /**
   * How long `close()` waits for an abort-ignoring runner to settle before
   * detaching the caller. Defaults to the lease TTL. Detaching only bounds the
   * caller-facing wait: the heartbeat keeps renewing and the lease is released
   * by the turn continuation once the runner actually settles, never handed
   * off while it may still be alive. `0` detaches immediately.
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
  readonly approvals: ExecutionApprovals;
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

class SessionPolicyRefusal extends Error {
  readonly code = "session_policy_refused";

  constructor(readonly reason: string) {
    super("session policy refused");
    this.name = "SessionPolicyRefusal";
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

export function getSessionHandle(id: string, runtime: SessionRuntime): SessionHandle | undefined {
  return registries.get(runtime)?.get(id);
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
  private readonly policies = createPolicyCompiler({
    source: {
      append: () => false,
      rows: (generation) => SessionHandleStore.policyRows(generation),
    },
  });
  private swept = false;
  private closed = false;

  constructor(private readonly runtime: SessionRuntime) {}

  pinPolicy(generation: number): CompiledPolicySnapshot {
    return this.policies.pin(generation);
  }

  get(id: string): SessionHandle | undefined {
    return this.entries.get(id)?.controller.handle;
  }

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
    controller = createController(id, runner, this.runtime, lifecycle, (generation) =>
      this.pinPolicy(generation),
    );
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
  pinPolicy: (generation: number) => CompiledPolicySnapshot,
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
  // Set from the moment an interrupted terminal is about to be sealed while
  // the runner ignored its abort, until that runner settles. It still holds
  // the durable lease, so configure must not rotate or release it.
  let liveInterruptRunner: Promise<SessionRunnerResult> | undefined;
  // Detached ownership maintenance for that runner (heartbeat + release once
  // it settles). No turn starts while it is pending.
  let retainedRunner: Promise<void> | undefined;
  // Release failure of that retained lease, re-thrown by the next turn start.
  let retainedFailure: Error | undefined;

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

  let activeApprovals: ExecutionApprovals | undefined;
  const handle: SessionHandle = {
    id: sessionId,
    approvals: {
      pending: () => activeApprovals?.pending() ?? [],
      async answer(answer) {
        if (activeApprovals === undefined) throw new ExecutionApprovalError("stale_approval");
        await activeApprovals.answer(answer);
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
        // Only the caller-facing wait is bounded. When the grace window lapses
        // the turn continuation keeps the heartbeat alive and releases the
        // lease itself once the abort-ignoring runner finally settles, so the
        // lease is never handed off while that runner may still be alive.
        const settled = Promise.all([active, retainedRunner]).then(
          () => undefined,
          () => undefined,
        );
        await Promise.race([settled, grace]);
      } finally {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        // A still-live turn or retained runner owns the lifecycle release: the
        // drive loop / retained continuation runs `hibernate()` once the lease
        // is actually released (see runTurn).
        if (active === undefined && retainedRunner === undefined) {
          released = true;
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
    if (kind === "interrupt" && current.state === "running") {
      try {
        const interrupted = SessionHandleStore.row(sessionId);
        const committed = SessionHandleStore.commit({
          sessionId,
          owner,
          fence,
          now: clock(),
          expectedRevision: interrupted.revision,
          actions: [],
          consumeInboxIds: [],
          state: "interrupted",
          releaseLease: false,
        });
        requireCommit(committed);
      } finally {
        controller?.abort();
      }
    }
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
    await awaitRetainedRunner();
    const current = SessionHandleStore.row(sessionId);
    fence = acquire(current.leaseFence);
    const actions = SessionHandleStore.tree(sessionId);
    const generation = SessionHandleStore.latestGeneration(actions);
    const pending = SessionHandleStore.pendingInbox(sessionId);
    const promptRefusal = await evaluatePromptPolicies(
      pending,
      pinPolicy(generation.policyGeneration),
    );
    if (promptRefusal !== undefined) {
      await consumePolicyBlockedInbox(pending, true);
      return policyRefusalResult(promptRefusal.reason);
    }
    const resultId = entropy();
    const turnId = entropy();
    const currentActions = SessionHandleStore.tree(sessionId);
    const parentActionId = currentActions.at(-1)?.id ?? null;
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
      expectedRevision: SessionHandleStore.row(sessionId).revision,
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

  async function evaluatePromptPolicies(
    items: readonly Inbox.Row[],
    policy: CompiledPolicySnapshot,
  ): Promise<SessionPolicyRefusal | undefined> {
    const ledger = createExecutionLedger();
    let refusal: SessionPolicyRefusal | undefined;
    for (const item of items) {
      if (item.kind !== "prompt") continue;
      const recorded: PlainValue = { inboxId: item.id, status: "recorded" };
      const outcome = await createExecutor({
        policy,
        ledger,
        observations: runtime.observations,
        identity: {
          sessionId,
          role: SessionHandleStore.row(sessionId).role,
          parentActionId: item.id,
        },
        clock,
        entropy,
      }).runExisting(
        {
          kind: "prompt",
          op: "inbox",
          intent: {
            inboxId: item.id,
            content: item.content,
            origin: item.origin.value,
            createdAt: item.createdAt,
            ordinal: item.ordinal,
          },
          effect: { status: "recorded" },
        },
        async () => recorded,
      );
      if (refusal !== undefined) continue;
      if (outcome.terminal !== "executed") {
        refusal = new SessionPolicyRefusal(outcome.reason);
      } else if (canonicalDigest(outcome.value) !== canonicalDigest(recorded)) {
        refusal = new SessionPolicyRefusal("invalid_output");
      }
    }
    return refusal;
  }

  async function consumePolicyBlockedInbox(
    items: readonly Inbox.Row[],
    releaseLease: boolean,
  ): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    commitSession({
      expectedRevision: current.revision,
      actions: [],
      consumeInboxIds: items.map((item) => item.id),
      state: current.state,
      releaseLease,
    });
  }

  function commitSession(input: {
    readonly expectedRevision: number;
    readonly actions: readonly LedgerAction.Append[];
    readonly consumeInboxIds: readonly string[];
    readonly state: LedgerSession.State;
    readonly releaseLease: boolean;
    readonly generation?: LedgerSession.GenerationPointers;
  }): Extract<LedgerSession.CommitResult, { readonly ok: true }> {
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence,
      now: clock(),
      expectedRevision: input.expectedRevision,
      actions: [...input.actions],
      consumeInboxIds: [...input.consumeInboxIds],
      state: input.state,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      releaseLease: input.releaseLease,
    });
    if (!committed.ok) throw new SessionCommitError(committed);
    return committed;
  }

  function createExecutionLedger(turnId?: string): SessionActionCommitPort {
    const executionFence = fence;
    return {
      async commit(action) {
        const current = SessionHandleStore.row(sessionId);
        const sealed =
          turnId !== undefined &&
          SessionHandleStore.tree(sessionId).some(
            (node) => SessionHandleStore.turnTerminal(node)?.turnId === turnId,
          );
        if (current.leaseFence !== executionFence || sealed) {
          throw new SessionCommitError({
            ok: false,
            reason: "stale",
            currentFence: current.leaseFence,
            currentRevision: current.revision,
          });
        }
        const receipt = commitSession({
          expectedRevision: current.revision,
          actions: [action],
          consumeInboxIds: [],
          state: current.state,
          releaseLease: false,
        }).receipts[0];
        if (receipt === undefined) throw new Error("single-action commit returned no receipt");
        return receipt;
      },
    };
  }

  async function resumeTurn(open: SessionHandleStore.OpenTurn): Promise<SessionRunnerResult> {
    await awaitRetainedRunner();
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
    await awaitRetainedRunner();
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
    const effects = new Set<Promise<void>>();
    const waves = new Set<Promise<void>>();
    const retainEffect = (effect: Promise<void>) => {
      effects.add(effect);
      void effect.then(() => effects.delete(effect));
    };
    const trackWave = (wave: Promise<void>) => {
      waves.add(wave);
      void wave.then(
        () => waves.delete(wave),
        () => waves.delete(wave),
      );
    };
    const policy = pinPolicy(input.generation.policyGeneration);
    const ledger = createExecutionLedger(input.turnId);
    const execution = createExecutor({
      policy,
      ledger,
      observations: runtime.observations,
      identity: { sessionId, role: row.role, parentActionId: input.turnId },
      clock,
      entropy,
    });
    const boundary = async (kind: SessionTurn.Boundary): Promise<SessionBoundaryResult> => {
      if (turnController.signal.aborted) return { messages: [], interrupted: true };
      const drained = await drainBoundary(
        input.turnId,
        input.resultId,
        kind,
        input.resumeCount,
        parentActionId,
        policy,
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
          () => {
            void Promise.allSettled([...waves]).then(() =>
              resolve({ kind: "interrupted", text: "" }),
            );
          },
          { once: true },
        );
      });
      let running: Promise<SessionRunnerResult> | undefined;
      let runnerResult: SessionRunnerResult | undefined;
      let evaluatedResult: PlainValue | undefined;
      const outcome = await execution.runExisting(
        {
          kind: "turn",
          op: "session",
          intent: {
            turnId: input.turnId,
            resultId: input.resultId,
            resumeCount: input.resumeCount,
            resume: input.resume,
            toolsGeneration: input.generation.generation,
            toolsHash: input.generation.toolsHash,
            systemHash: input.generation.systemHash,
            policyGeneration: input.generation.policyGeneration,
          },
          effect: { terminal: "sealed" },
        },
        async () => {
          if (turnController.signal.aborted) {
            runnerResult = { kind: "interrupted", text: "" };
          } else {
            running = (async () => {
              try {
                return await runner({
                  sessionId,
                  role: row.role,
                  turnId: input.turnId,
                  actionId: input.parentActionId,
                  ledger,
                  retainEffect,
                  trackWave,
                  bindApprovals: (approvals) => {
                    activeApprovals = approvals;
                  },
                  policy,
                  execution,
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
              } finally {
                await Promise.allSettled([...effects]);
              }
            })();
            try {
              runnerResult = await Promise.race([running, aborted]);
            } catch (error) {
              runnerResult = {
                kind: "error",
                text: error instanceof Error ? error.message : String(error),
                ...(error instanceof Error ? { cause: error } : {}),
              };
            }
          }
          evaluatedResult = sessionRunnerResultValue(runnerResult);
          return evaluatedResult;
        },
      );
      if (outcome.terminal !== "executed") {
        result = policyRefusalResult(outcome.reason);
      } else if (runnerResult === undefined || evaluatedResult === undefined) {
        result = policyRefusalResult("invalid_output");
      } else if (canonicalDigest(outcome.value) === canonicalDigest(evaluatedResult)) {
        result = runnerResult;
      } else {
        result =
          sessionRunnerResultFromValue(outcome.value) ?? policyRefusalResult("invalid_output");
      }
      if (turnController.signal.aborted && running !== undefined) {
        interruptedRunner = running;
        // Mark the live runner BEFORE the interrupted terminal is sealed: any
        // configure re-entered from a synchronous observation of that seal
        // must already see the lease as held by this executor.
        liveInterruptRunner = running;
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
      // lease (renewed by the heartbeat above). The interrupted terminal is
      // sealed, so the turn - and the caller's interrupt() - completes now;
      // ownership maintenance detaches into `retainedRunner`: once the runner
      // settles, stop the heartbeat and release the lease. Every turn start
      // waits on it, so a resume can only run once this executor is genuinely
      // gone - session-wide single flight without an unbounded caller wait.
      retainedRunner = interruptedRunner
        .then(
          () => undefined,
          () => undefined,
        )
        .then(async () => {
          liveInterruptRunner = undefined;
          stopHeartbeat?.();
          stopHeartbeat = undefined;
          try {
            await releaseHeldLease();
          } catch (error) {
            // Storage refused/failed the release: never wedge the controller on
            // a detached promise. Finalize in-memory state here and surface the
            // failure to the next caller that starts a turn.
            retainedFailure = error instanceof Error ? error : new Error(String(error));
          } finally {
            retainedRunner = undefined;
          }
          if (active === undefined) await hibernate(SessionHandleStore.row(sessionId));
        });
    }
    return result;
  }

  async function awaitRetainedRunner(): Promise<void> {
    while (retainedRunner !== undefined) await retainedRunner;
    if (retainedFailure !== undefined) {
      const failure = retainedFailure;
      retainedFailure = undefined;
      throw failure;
    }
  }

  async function drainBoundary(
    turnId: string,
    resultId: string,
    boundary: SessionTurn.Boundary,
    resumeCount: number,
    parentActionId: string,
    policy: CompiledPolicySnapshot,
  ): Promise<{
    readonly messages: (SessionTurn.Message & { readonly id?: string })[];
    readonly interrupted: boolean;
    readonly parentActionId: string;
    readonly boundaryActionId: string;
  }> {
    const pending = SessionHandleStore.pendingInbox(sessionId);
    const promptRefusal = await evaluatePromptPolicies(pending, policy);
    if (promptRefusal !== undefined) {
      await consumePolicyBlockedInbox(pending, false);
      throw promptRefusal;
    }
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
      state: current.state === "interrupted" ? "interrupted" : "running",
      releaseLease: false,
    });
    requireCommit(committed);
    const interrupted = pending.some((item) => item.kind === "interrupt");
    const messages = pending
      .filter((item) => item.kind === "prompt")
      .map((item) => ({ id: item.id, role: "user" as const, text: item.content }));
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

  // Same liveness rule the ledger's fenced commit applies: a lapsed lease is
  // dead (TTL takeover territory) even while the row still names its owner.
  function leaseLive(row: LedgerSession.Row): boolean {
    return (
      row.leaseOwner !== null &&
      row.leaseExpiresAt !== null &&
      !Deadline.isExpired(clock(), row.leaseExpiresAt)
    );
  }

  async function releaseHeldLease(): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    // Lease already stolen or lapsed: nothing of ours left to release. A lapsed
    // lease is recoverable by TTL takeover; releasing it would be refused as
    // stale by the fenced kernel.
    if (current.leaseOwner !== owner || current.leaseFence !== fence) return;
    if (!leaseLive(current)) return;
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
      (active !== undefined || current.state === "running" || liveInterruptRunner !== undefined);
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
    if (leaseLive(current)) return;
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

function sessionMessages(
  actions: readonly LedgerAction.Node[],
): (SessionTurn.Message & { readonly id: string })[] {
  const messages: (SessionTurn.Message & { readonly id: string })[] = [];
  for (const action of actions) {
    const delivered = SessionHandleStore.delivery(action);
    if (delivered?.kind === "prompt") {
      messages.push({ id: delivered.inboxId, role: "user", text: delivered.content });
    }
    const terminal = SessionHandleStore.turnTerminal(action);
    if (terminal !== undefined && terminal.text.length > 0) {
      messages.push({ id: action.id, role: "assistant", text: terminal.text });
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

function policyRefusalResult(reason: string): SessionRunnerResult {
  const cause = new SessionPolicyRefusal(reason);
  return { kind: "error", text: cause.message, cause };
}

function sessionRunnerResultValue(result: SessionRunnerResult): PlainValue {
  if (result.kind === "interrupted") {
    return { kind: result.kind, ...(result.text === undefined ? {} : { text: result.text }) };
  }
  if (result.kind === "error") {
    return {
      kind: result.kind,
      text: result.text,
      ...(result.reported === undefined ? {} : { reported: result.reported }),
    };
  }
  return {
    kind: result.kind,
    text: result.text,
    ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
    ...(result.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            ...(result.usage.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: result.usage.reasoningTokens }),
            ...(result.usage.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: result.usage.cacheReadTokens }),
            ...(result.usage.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: result.usage.cacheWriteTokens }),
          },
        }),
  };
}

function sessionRunnerResultFromValue(value: PlainValue): SessionRunnerResult | undefined {
  if (!plainObject(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "interrupted") {
    if (!onlyKeys(value, ["kind", "text"])) return undefined;
    if ("text" in value && typeof value.text !== "string") return undefined;
    return { kind: "interrupted", ...(typeof value.text === "string" ? { text: value.text } : {}) };
  }
  if (value.kind === "error") {
    if (!onlyKeys(value, ["kind", "text", "reported"]) || typeof value.text !== "string") {
      return undefined;
    }
    if ("reported" in value && value.reported !== true) return undefined;
    return {
      kind: "error",
      text: value.text,
      ...(value.reported === true ? { reported: true as const } : {}),
    };
  }
  if (value.kind !== "result") return undefined;
  if (!onlyKeys(value, ["kind", "text", "finishReason", "usage"])) return undefined;
  if (typeof value.text !== "string") return undefined;
  const finishReason = value.finishReason;
  if (
    finishReason !== undefined &&
    finishReason !== "stop" &&
    finishReason !== "max-steps" &&
    finishReason !== RunReasonCode.Stalled
  ) {
    return undefined;
  }
  const usage = value.usage === undefined ? undefined : sessionUsageFromValue(value.usage);
  if (value.usage !== undefined && usage === undefined) return undefined;
  return {
    kind: "result",
    text: value.text,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
  };
}

type SessionUsage = NonNullable<Extract<SessionRunnerResult, { readonly kind: "result" }>["usage"]>;

function sessionUsageFromValue(value: PlainValue): SessionUsage | undefined {
  if (
    !plainObject(value) ||
    !onlyKeys(value, [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "reasoningTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ])
  ) {
    return undefined;
  }
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const totalTokens = value.totalTokens;
  if (!finiteNumber(inputTokens) || !finiteNumber(outputTokens) || !finiteNumber(totalTokens)) {
    return undefined;
  }
  const reasoningTokens = optionalFiniteNumber(value, "reasoningTokens");
  const cacheReadTokens = optionalFiniteNumber(value, "cacheReadTokens");
  const cacheWriteTokens = optionalFiniteNumber(value, "cacheWriteTokens");
  if (reasoningTokens === false || cacheReadTokens === false || cacheWriteTokens === false) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function optionalFiniteNumber(value: PlainObject, key: string): number | undefined | false {
  if (!(key in value)) return undefined;
  const candidate = value[key];
  return finiteNumber(candidate) ? candidate : false;
}

function finiteNumber(value: PlainValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function plainObject(value: PlainValue): value is PlainObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function onlyKeys(value: PlainObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function defaultHeartbeat(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
