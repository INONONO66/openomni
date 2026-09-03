import { SessionHandleStore } from "@openomni/ledger";
import {
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type ObservationSink,
  SessionGeneration,
  type SessionTurn,
} from "@openomni/protocol";

export interface SessionTool {
  readonly name: string;
  readonly inputSchema: SessionGeneration.Tool["inputSchema"];
  readonly category: SessionGeneration.ToolCategory;
}

export interface SessionSystem {
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

export interface SessionGetOptions {
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

export interface SessionBoundaryResult {
  readonly messages: readonly SessionTurn.Message[];
  readonly interrupted: boolean;
}

export type SessionRunnerResult =
  | { readonly kind: "result"; readonly text: string }
  | { readonly kind: "interrupted"; readonly text?: string }
  | { readonly kind: "error"; readonly text: string };

export type SessionRunner = (input: SessionRunnerInput) => Promise<SessionRunnerResult>;

export interface SessionRuntime {
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly processId?: string;
  readonly observations: ObservationSink;
  readonly authorizeConfigure?: SessionHandleStore.ConfigureAuthority;
  readonly scheduleHeartbeat?: (callback: () => void, intervalMs: number) => () => void;
  readonly onHibernate?: (sessionId: string) => void | Promise<void>;
}

export interface SessionToolsHandle {
  add(tools: readonly SessionTool[]): Promise<SessionGeneration.ConfigureReceipt>;
  remove(names: readonly string[]): Promise<SessionGeneration.ConfigureReceipt>;
}

export interface SessionSystemBlocksHandle {
  set(
    blocks: readonly SessionGeneration.SystemBlock[],
  ): Promise<SessionGeneration.ConfigureReceipt>;
}

export interface SessionHandle {
  readonly id: string;
  readonly tools: SessionToolsHandle;
  readonly system: { readonly blocks: SessionSystemBlocksHandle };
  prompt(content: string, origin?: Inbox.Origin): Promise<void>;
  interrupt(origin?: Inbox.Origin): Promise<void>;
  resume(origin?: Inbox.Origin): Promise<void>;
  get(options?: SessionGetOptions): SessionTurn.Snapshot;
  watch(options?: SessionGetOptions): SessionTurn.Watch;
  close(): Promise<void>;
}

export class SessionLeaseError extends Error {
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
  reconcile(): Promise<void>;
  isRunning(): boolean;
}

interface RegistryEntry {
  readonly runner: SessionRunner;
  readonly controller: SessionController;
}

const registries = new WeakMap<ObservationSink, SessionRegistry>();

export function session(options: SessionCreateOptions, runtime: SessionRuntime): SessionHandle {
  let registry = registries.get(runtime.observations);
  if (registry === undefined) {
    registry = new SessionRegistry(runtime);
    registries.set(runtime.observations, registry);
  }
  return registry.declare(options);
}

export async function sweepSessions(
  resolveRunner: (row: LedgerSession.Row) => SessionRunner,
  runtime: SessionRuntime,
): Promise<void> {
  let registry = registries.get(runtime.observations);
  if (registry === undefined) {
    registry = new SessionRegistry(runtime);
    registries.set(runtime.observations, registry);
  }
  await registry.sweep(resolveRunner);
}

export async function closeSessions(runtime: SessionRuntime): Promise<void> {
  const registry = registries.get(runtime.observations);
  if (registry === undefined) return;
  registries.delete(runtime.observations);
  await registry.close();
}

class SessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private swept = false;

  constructor(private readonly runtime: SessionRuntime) {}

  declare(options: SessionCreateOptions): SessionHandle {
    const entropy = this.runtime.entropy ?? crypto.randomUUID;
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
    await Promise.all([...this.entries.values()].map((entry) => entry.controller.handle.close()));
    this.entries.clear();
  }

  private install(id: string, runner: SessionRunner): RegistryEntry {
    const existing = this.entries.get(id);
    if (existing !== undefined) return existing;
    const controller = createController(id, runner, this.runtime, () => {
      this.entries.delete(id);
    });
    const entry = { runner, controller };
    this.entries.set(id, entry);
    return entry;
  }
}

function createController(
  sessionId: string,
  runner: SessionRunner,
  runtime: SessionRuntime,
  evict: () => void,
): SessionController {
  const clock = runtime.clock ?? Date.now;
  const entropy = runtime.entropy ?? crypto.randomUUID;
  const owner = `${runtime.processId ?? String(process.pid)}:${entropy()}`;
  const scheduleHeartbeat = runtime.scheduleHeartbeat ?? defaultHeartbeat;
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let fence = SessionHandleStore.row(sessionId).leaseFence;
  let closed = false;
  let stopHeartbeat: (() => void) | undefined;

  const tools: SessionToolsHandle = {
    async add(additions) {
      const current = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
      const names = new Set(additions.map((tool) => tool.name));
      const next = [
        ...current.tools.filter((tool) => !names.has(tool.name)),
        ...additions.map(toolSnapshot),
      ];
      return configure("tools.add", next, {
        preset: current.systemPreset,
        blocks: current.systemBlocks,
      });
    },
    async remove(names) {
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
    prompt: (content, origin = internalOrigin(sessionId)) => enqueue("prompt", content, origin),
    interrupt: (origin = internalOrigin(sessionId)) => enqueue("interrupt", "", origin),
    resume: (origin = internalOrigin(sessionId)) => enqueue("resume", "", origin),
    get: (options = {}) => SessionHandleStore.getSnapshot(sessionId, options.turns ?? 1),
    watch: (options = {}) =>
      SessionHandleStore.watchSnapshot(
        sessionId,
        options.turns ?? 1,
        runtime.observations,
        () => undefined,
      ),
    async close() {
      closed = true;
      controller?.abort();
      await active;
      stopHeartbeat?.();
    },
  };

  async function enqueue(kind: Inbox.Kind, content: string, origin: Inbox.Origin): Promise<void> {
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
    if (kind === "resume" && current.state === "running") return;
    await reconcile();
  }

  async function reconcile(): Promise<void> {
    if (closed || active !== undefined) return active;
    const work = driveAvailable().finally(() => {
      active = undefined;
    });
    active = work;
    return work;
  }

  async function driveAvailable(): Promise<void> {
    for (;;) {
      if (closed) return;
      const actions = SessionHandleStore.tree(sessionId);
      const open = SessionHandleStore.openTurns(actions).at(-1);
      if (open !== undefined) {
        await resumeTurn(open);
        continue;
      }
      const pending = SessionHandleStore.pendingInbox(sessionId);
      if (pending.length === 0) return;
      const current = SessionHandleStore.row(sessionId);
      if (current.state === "interrupted") {
        const resume = pending.find((item) => item.kind === "resume");
        if (resume === undefined) return;
        await resumeInterrupted(resume);
        continue;
      }
      const prompts = pending.filter((item) => item.kind === "prompt");
      if (prompts.length > 0) {
        await startTurn();
        continue;
      }
      await consumeNoopInbox(pending);
    }
  }

  async function startTurn(): Promise<void> {
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
      state: pending.some((item) => item.kind === "interrupt") ? "interrupted" : "running",
      releaseLease: pending.some((item) => item.kind === "interrupt"),
    });
    const row = requireCommit(committed);
    if (pending.some((item) => item.kind === "interrupt")) {
      await hibernate(row);
      return;
    }
    await runTurn({
      turnId,
      resultId,
      parentActionId: envelope.id,
      boundaryActionId: parentActionId,
      resumeCount: 0,
      generation,
      resume: false,
    });
  }

  async function resumeTurn(open: SessionHandleStore.OpenTurn): Promise<void> {
    if (open.resumeCount >= SessionHandleStore.RESUME_BUDGET) {
      fence = acquire(SessionHandleStore.row(sessionId).leaseFence);
      await seal(open, { kind: "error", text: "session resume budget exhausted" });
      return;
    }
    const current = SessionHandleStore.row(sessionId);
    fence = acquire(current.leaseFence);
    const generation = generationForOpen(open);
    const resumeCount = open.resumeCount + 1;
    const resumeId = entropy();
    const resultId = entropy();
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
    await runTurn({
      turnId: open.turnId,
      resultId,
      parentActionId: resumeId,
      boundaryActionId: open.boundaryActionId,
      resumeCount,
      generation,
      resume: true,
    });
  }

  async function resumeInterrupted(item: Inbox.Row): Promise<void> {
    const terminal = latestTerminal(SessionHandleStore.tree(sessionId));
    if (terminal === undefined) {
      await consumeNoopInbox([item]);
      return;
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
    await runTurn({
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
  }): Promise<void> {
    const row = SessionHandleStore.row(sessionId);
    controller = new AbortController();
    stopHeartbeat = scheduleHeartbeat(() => {
      const now = clock();
      const renewed = SessionHandleStore.renewLease({
        sessionId,
        owner,
        fence,
        now,
        expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
      });
      if (!renewed) controller?.abort();
    }, SessionHandleStore.HEARTBEAT_INTERVAL_MS);
    let parentActionId = input.parentActionId;
    let boundaryActionId = input.boundaryActionId;
    let result: SessionRunnerResult;
    const boundary = async (kind: SessionTurn.Boundary): Promise<SessionBoundaryResult> => {
      const drained = await drainBoundary(
        input.turnId,
        input.resultId,
        kind,
        input.resumeCount,
        boundaryActionId,
        parentActionId,
      );
      parentActionId = drained.parentActionId;
      boundaryActionId = drained.boundaryActionId;
      if (drained.interrupted) controller?.abort();
      return { messages: drained.messages, interrupted: drained.interrupted };
    };
    try {
      result = await runner({
        sessionId,
        role: row.role,
        turnId: input.turnId,
        resultId: input.resultId,
        parentActionId,
        boundaryActionId,
        messages: messagesForTurn(SessionHandleStore.tree(sessionId), input.turnId),
        tools: input.generation.tools,
        toolsGeneration: input.generation.generation,
        toolsHash: input.generation.toolsHash,
        system: input.generation.systemValue,
        systemHash: input.generation.systemHash,
        policyGeneration: input.generation.policyGeneration,
        resumeCount: input.resumeCount,
        signal: controller.signal,
        boundary,
      });
      if (controller.signal.aborted && result.kind !== "interrupted") {
        result = { kind: "interrupted", text: "" };
      }
    } catch (error) {
      result = controller.signal.aborted
        ? { kind: "interrupted", text: "" }
        : { kind: "error", text: error instanceof Error ? error.message : String(error) };
    } finally {
      stopHeartbeat?.();
      stopHeartbeat = undefined;
      controller = undefined;
    }
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
        action: SessionHandleStore.tree(sessionId).at(-1)!,
      },
      result,
    );
  }

  async function drainBoundary(
    turnId: string,
    resultId: string,
    boundary: SessionTurn.Boundary,
    resumeCount: number,
    previousBoundaryActionId: string | null,
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
  ): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    const actions = SessionHandleStore.tree(sessionId);
    const terminal = turnTerminalAction({
      id: open.resultId,
      parentId: actions.at(-1)?.id ?? open.action.id,
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
      actions: [terminal],
      consumeInboxIds: [],
      state: nextState,
      releaseLease: true,
    });
    const sealed = requireCommit(committed);
    await hibernate(sealed);
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
    await hibernate(SessionHandleStore.row(sessionId));
  }

  async function configure(
    operation: SessionGeneration.ConfigureIntent["operation"],
    nextTools: readonly SessionGeneration.Tool[],
    nextSystem: SessionSystem,
  ): Promise<SessionGeneration.ConfigureReceipt> {
    const current = SessionHandleStore.row(sessionId);
    const actions = SessionHandleStore.tree(sessionId);
    const previous = SessionHandleStore.latestGeneration(actions);
    const generation = previous.generation + 1;
    const authorized =
      (await runtime.authorizeConfigure?.({
        sessionId,
        role: current.role,
        operation,
        generation,
      })) ?? true;
    if (!authorized) {
      throw new SessionGeneration.ConfigureError({
        code: "denied",
        message: `session configure denied: ${operation}`,
      });
    }
    const snapshot = SessionHandleStore.generationSnapshot({
      generation,
      revertTo: previous.generation,
      tools: nextTools,
      system: nextSystem,
      policyGeneration: previous.policyGeneration,
    });
    fence = acquire(current.leaseFence);
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
      releaseLease: true,
    });
    requireCommit(committed);
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
    if (current.leaseOwner !== null) return;
    if (SessionHandleStore.pendingInbox(sessionId).length > 0) return;
    await runtime.onHibernate?.(sessionId);
    evict();
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

function messagesForTurn(
  actions: readonly LedgerAction.Node[],
  turnId: string,
): SessionTurn.Message[] {
  const messages: SessionTurn.Message[] = [];
  for (const action of actions) {
    const delivered = SessionHandleStore.delivery(action);
    if (delivered?.turnId === turnId && delivered.kind === "prompt") {
      messages.push({ role: "user", text: delivered.content });
    }
    const terminal = SessionHandleStore.turnTerminal(action);
    if (terminal?.turnId === turnId && terminal.text.length > 0) {
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
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: {
        phase: "intent",
        resultId: input.resultId,
        inboxIds: [...input.inboxIds],
        toolsGeneration: input.generation.generation,
        toolsHash: input.generation.toolsHash,
        systemHash: input.generation.systemHash,
        policyGeneration: input.generation.policyGeneration,
        resumeCount: input.resumeCount,
        boundaryActionId: input.boundaryActionId,
      },
    },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts: input.at,
  };
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
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: {
        phase: "resume",
        turnId: input.turnId,
        resultId: input.resultId,
        toolsGeneration: input.generation.generation,
        toolsHash: input.generation.toolsHash,
        systemHash: input.generation.systemHash,
        policyGeneration: input.generation.policyGeneration,
        resumeCount: input.resumeCount,
        boundaryActionId: input.boundaryActionId,
      },
    },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts: input.at,
  };
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
