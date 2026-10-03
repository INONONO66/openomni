import { Clock, Effect, Context, type Fiber, Exit, Layer, Scope, Semaphore, Cause } from "effect";
import * as Failure from "./failure";
import { type SessionError, type ExecutionError, RunnerOutputMissing, CommitFailed, AgentFailure, GenerationUnavailable, GenerationUnsettled, AgentInvariantViolation, InboundAuthorityViolation } from "./failure";
import { type ExecutionLedger, type ExecutionApprovals, type ExecutionResult, type ExecutorOptions, createRawSlots, createExecutor, type Executor } from "./gate/decide";
import type { SessionPolicyRefusal } from "./messages";
export { SessionPolicyRefusal } from "./messages";
import { GenerationRawSlots } from "./gate/decide";
export { GenerationRawSlots } from "./gate/decide";

import * as SessionHandleStore from "./store/fence";
import type { SessionKernel } from "./entity";
import type { InspectRequest, InspectionPage } from "../inspect";
import { Inbox, type LedgerAction, type LedgerSession, type ObservationSink, type SessionGeneration, type SessionHistory, type SessionTurn, SessionTransition, canonicalDigest, PlainValueSchema, BusEvent, type PlainValue, type TraceContext } from "@openomni/protocol";
import type { ChatAgentConfig, AgentResult } from "./types";
import type { decideSessionAdmission } from "./mailbox";
import { Entropy, ObservationSink as ObservationService, GenerationLayers, type SessionEntryServices, type RunnerServices, GenerationOwnership, type CapturedGeneration, type GenerationServices, interruptOn, } from "./ports";
import { commitFoldBatch, turnCheckpointAction, deliveryActions, turnTerminalAction, policyRefusalResult, sessionRunnerResultValue, sessionRunnerResultFromValue, pendingBacklog, receivedMessages, } from "./commit";
import type { LedgerError } from "./store/errors";
import { z } from "zod";
import { hydrateSessionHistory, refreshSessionHistory } from "../inspect/history";
import { parentReply } from "../plugins/parent-reply";
import { observeDrained, scopeObservation } from "./bus";
import { runAgent } from "./turn";
import { pinnedModelSelection } from "../plugins/model-selection";

// ─── from session-contract.ts (#1247) ───
export interface SessionTool {
  readonly name: string;
  readonly inputSchema: SessionGeneration.Tool["inputSchema"];
  readonly category: SessionGeneration.ToolCategory;
  readonly sequential?: true;
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
  readonly bundles?: readonly string[];
}

interface SessionGetOptions {
  readonly turns?: number;
}

export interface SessionActionCommitPort extends ExecutionLedger {}

export interface SessionRunnerInput {
  /** Authenticated inbox treatment, independent of model-visible message text. */
  readonly authority?: "act" | "evidence_only";
  readonly sessionId: string;
  readonly kernel: SessionKernel;
  readonly role: LedgerSession.Role;
  readonly turnId: string;
  readonly actionId: string;
  readonly ledger: SessionActionCommitPort;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly trackWave?: (wave: Promise<void>) => void;
  readonly bindApprovals?: (approvals: ExecutionApprovals) => void;
  readonly stopEvidence?: ChatAgentConfig["stopEvidence"];
  readonly resultId: string;
  readonly parentActionId: string | null;
  readonly boundaryActionId: string | null;
  readonly messages: readonly (SessionTurn.Message & {
    readonly id?: string;
    readonly time?: number;
  })[];
  readonly history?: readonly import("@openomni/protocol").Message.WithParts[];
  readonly tools: readonly SessionGeneration.Tool[];
  readonly toolsGeneration: number;
  readonly toolsHash: string;
  readonly system: string;
  readonly systemHash: string;
  readonly policyGeneration: number;
  readonly resumeCount: number;
  readonly signal: AbortSignal;
  readonly boundary: (boundary: SessionTurn.Boundary) => Effect.Effect<SessionBoundaryResult, ExecutionError>;
}

export interface SessionBoundaryResult {
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
  | {
      readonly kind: "waiting";
      readonly reason: "live_wait";
      readonly alarmIds: readonly string[];
      readonly text: string;
    }
  | { readonly kind: "interrupted"; readonly text?: string }
  | {
      readonly kind: "error";
      readonly text: string;
      readonly cause?: Error | SessionPolicyRefusal | RunnerOutputMissing;
      readonly reported?: true;
    };

export type SessionRunner = (input: SessionRunnerInput) => Effect.Effect<SessionRunnerResult, ExecutionError, RunnerServices>;

export interface SessionRuntime {
  /** Dispatches only an already committed source obligation through gateway admission. */
  readonly dispatchOutbound?: (input: {
    readonly message: SessionTransition.OutboundMessage;
    readonly authority: { readonly owner: string; readonly fence: number };
  }) => Effect.Effect<LedgerAction.Receipt, ExecutionError, RunnerServices>;
  /** Direct post-commit doorbells, independent of the lossy observation bus. */
  readonly onInboxCommitted?: (sessionIds: readonly string[]) => void;
  readonly openIntent?: (input: {
    sessionId: string;
    turnId: string;
    revision: number;
  }) => Effect.Effect<readonly { actionId: string; kind: "message" | "approval" }[], ExecutionError>;
  readonly retryAlarm?: ExecutorOptions["retryAlarm"];
  readonly approvalTimeoutMs?: ExecutorOptions["approvalTimeoutMs"];
  readonly processId?: string;
  /** Required pinned pre-policy authority for `session.configure`; there is no allow fallback. */
  readonly authorizeConfigure: (input: Parameters<SessionHandleStore.ConfigureAuthority>[0]) => Effect.Effect<boolean, SessionError>;
  readonly authorizeApproval?: ExecutorOptions["authorizeApproval"];
  readonly requestDomainRevisions?: (
    request: SessionTransition.Request,
  ) => Readonly<Record<string, number>>;
  readonly onRequestReady?: (sessionId: string) => void;
  /**
   * Handle-scoped kernel opener (W5.2 F1): every controller reads and commits
   * through the kernel this returns for its session. Fenced single-writer
   * contract: every commit carries the fence adopted at activation, so a
   * stale writer can never commit after another one took over. There is no
   * liveness heartbeat - the fence CAS is the takeover authority. A runner
   * MUST still honour aborts promptly - an abort-ignoring runner keeps
   * computing without authority and its late result is discarded.
   */
  readonly openKernel: (sessionId: string) => SessionKernel;
  /** Catalog-backed enumeration of durable sessions this process can open. */
  readonly listSessions: () => LedgerSession.Row[];
  readonly onHibernate?: (sessionId: string) => Effect.Effect<void, ExecutionError>;
  /**
   * How long `close()` waits for an abort-ignoring runner to settle before
   * detaching the caller. Detaching only bounds the caller-facing wait: the
   * turn continuation still settles durably before authority moves on. `0`
   * detaches immediately.
   */
  readonly closeGraceMs?: number;
}

/** Captured once by registry/request acquisition, never an alternate public service API. */
export interface ResolvedSessionRuntime extends SessionRuntime {
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly observations: ObservationSink;
  readonly generations: Context.Service.Shape<typeof GenerationLayers>;
  readonly services: Context.Context<SessionEntryServices>;
}

export function resolveSessionRuntime(runtime: SessionRuntime): Effect.Effect<ResolvedSessionRuntime, never, SessionEntryServices> {
  return Effect.gen(function* () {
    const services = yield* Effect.context<SessionEntryServices>();
    const clock = yield* Clock.clockWith(Effect.succeed);
    const entropy = yield* Entropy;
    const observations = yield* ObservationService;
    const generations = yield* GenerationLayers;
    return { ...runtime, clock: () => clock.currentTimeMillisUnsafe(), entropy: entropy.id, observations, generations, services };
  });
}

interface SessionToolsHandle {
  add(tools: readonly SessionTool[]): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError>;
  remove(names: readonly string[]): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError>;
}

interface SessionSystemBlocksHandle {
  set(
    blocks: readonly SessionGeneration.SystemBlock[],
  ): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError>;
}

export interface SessionHandle {
  readonly id: string;
  readonly approvals: ExecutionApprovals;
  readonly requests: {
    transition(
      payload: SessionTransition.Payload,
      inputId: string,
      at: number,
      admission?: Inbox.Commit,
    ): Effect.Effect<import("./request").RequestDecision, ExecutionError>;
  };
  readonly tools: SessionToolsHandle;
  readonly system: { readonly blocks: SessionSystemBlocksHandle };
  prompt(content: string, origin?: Inbox.Origin): Effect.Effect<SessionRunnerResult | undefined, SessionError>;
  interrupt(origin?: Inbox.Origin): Effect.Effect<void, SessionError>;
  resume(origin?: Inbox.Origin): Effect.Effect<void, SessionError>;
  /** Record the typed compensation of one compaction (`restore_context_projection`); history is never erased. */
  restoreContext(compactionId: string): Effect.Effect<ExecutionResult, SessionError>;
  get(options?: SessionGetOptions): SessionTurn.Snapshot;
  watch(options?: SessionGetOptions): SessionTurn.Watch;
  /** Bounded revision page of committed actions; the resynchronization read after a `watch` gap. */
  history(request?: SessionHistory.PageRequest): SessionHistory.Page;
  /** Redacted causal projection over this session and the sessions it commissioned. */
  inspect(request?: InspectRequest): InspectionPage;
  close(): Effect.Effect<void, SessionError>;
}

export interface SessionController {
  readonly handle: SessionHandle;
  readonly owner: string;
  reconcile(): Effect.Effect<SessionRunnerResult | undefined, SessionError>;
}

export interface RegistryEntry {
  readonly runner: SessionRunner;
  readonly controller: SessionController;
}

export interface SessionControllerLifecycle {
  reactivate(): Effect.Effect<SessionHandle, SessionError>;
  release(): void;
}

/**
 * Ports the Session entity handler (W5.2 #1197) receives from composition.
 * The entity owns receipt, dedupe, fence authority and backlog admission; the
 * turn machinery and the chain-guarded timer folds stay behind these ports so
 * the durable protocol and the execution engine evolve independently.
 */

export type SessionAdmissionSnapshot = Parameters<typeof decideSessionAdmission>[0];
type SessionAdmissionDecision = ReturnType<typeof decideSessionAdmission>;

/** The fence identity one activation writes with; rotated once at activation. */
export interface SessionEntityAuthority {
  readonly sessionId: string;
  readonly owner: string;
  readonly fence: number;
}

/** An admitted unit of turn work: everything but `stop`/`refused`/`consume`. */
export interface SessionEntityTurnInput {
  readonly authority: SessionEntityAuthority;
  readonly kernel: SessionKernel;
  readonly decision:
    | { readonly kind: "start" }
    | Extract<SessionAdmissionDecision, { kind: "recover" } | { kind: "resume" }>;
  readonly snapshot: SessionAdmissionSnapshot;
  /**
   * Detaches the admitted turn's post-boundary remainder (W5.2 S4). The port
   * calls it only after the durable turn boundary (deliveries + turn
   * envelope, state `running`) is committed; the entity forks the body under
   * the activation so the delivering RPC acks at the boundary instead of
   * joining the whole model turn (a parent awaiting its child's Prompt RPC
   * inside its own turn would otherwise deadlock the two mailboxes).
   * Fixtures may run the body inline.
   */
  readonly detach: (body: Effect.Effect<void, SessionError>) => Effect.Effect<void, SessionError>;
}

export interface SessionEntityTimerContext {
  readonly authority: SessionEntityAuthority;
  readonly kernel: SessionKernel;
  readonly now: number;
}

export type SessionTimerOutcome = "applied" | "noop";

/** Chain-guarded timer folds (plan C2/F2); superseded wakes resolve to `noop`. */
interface SessionEntityTimerPort {
  readonly retryScheduled: (
    context: SessionEntityTimerContext,
    payload: { readonly alarmId: string; readonly attempt: number; readonly notBefore: number },
  ) => Effect.Effect<SessionTimerOutcome, SessionError>;
  readonly deadline: (
    context: SessionEntityTimerContext,
    payload: { readonly requestId: string; readonly deadlineAt: number },
  ) => Effect.Effect<SessionTimerOutcome, SessionError>;
  readonly watchFired: (
    context: SessionEntityTimerContext,
    payload: {
      readonly watchId: string;
      readonly epoch: number;
      readonly sourceKey: string;
      readonly batch: string;
    },
  ) => Effect.Effect<SessionTimerOutcome, SessionError>;
  readonly watchTimeout: (
    context: SessionEntityTimerContext,
    payload: { readonly watchId: string; readonly epoch: number; readonly fireAt: number },
  ) => Effect.Effect<SessionTimerOutcome, SessionError>;
}

export interface SessionEntityPorts {
  /** Runs one admitted decision to a durable boundary; the ack follows its commits. */
  readonly runTurn: (input: SessionEntityTurnInput) => Effect.Effect<void, SessionError>;
  readonly timers: SessionEntityTimerPort;
  /** Optional domain-revision capture for request bindings, as on `SessionRuntime`. */
  readonly requestDomainRevisions?: (
    request: SessionTransition.Request,
  ) => Readonly<Record<string, number>>;
}

// ─── from controller-state (#1247) ───
export interface SessionControllerState {
  active: Fiber.Fiber<SessionRunnerResult | undefined, SessionError> | undefined;
  controller: AbortController | undefined;
  fence: number;
  closed: boolean;
  terminalFrozen: boolean;
  released: boolean;
  successor: SessionHandle | undefined;
  retainedRunner: Fiber.Fiber<void, SessionError> | undefined;
  rawSlots: ReturnType<typeof createRawSlots>;
  activeApprovals: ExecutionApprovals | undefined;
}

// ─── from session-configuration.ts (#1247) ───
/**
 * Adopts a strictly newer fence for this writer (W5.2 F5). There is no lease
 * TTL and no heartbeat: the fence CAS is the whole takeover authority. A lost
 * single-increment race re-reads the row and re-decides from the fresh fence.
 */
export function adoptSessionAuthority(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
): Effect.Effect<number, LedgerError> {
  const attempt: Effect.Effect<number, LedgerError> = Effect.suspend(() => {
    const current = kernel.row(sessionId);
    if (current.fenceOwner === owner) return Effect.succeed(current.fence);
    return kernel
      .adoptFence({ sessionId, owner, fence: current.fence + 1 })
      .pipe(
        Effect.map((receipt) => receipt.fence),
        Effect.catchTag("FenceRefused", () => attempt),
      );
  });
  return attempt;
}

export function createSessionConfiguration(
  kernel: SessionKernel,
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  ports: {
    readonly hibernate: (current: LedgerSession.Row) => Effect.Effect<void, SessionError>;
  },
) {
  function configure(
    operation: SessionGeneration.ConfigureIntent["operation"],
    nextTools: readonly SessionGeneration.Tool[],
    nextSystem: SessionSystem,
  ): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError> {
    return Effect.gen(function* () {
      const before = kernel.latestGenerationFor(sessionId);
      const generation = before.generation + 1;
      const accepted = yield* runtime.authorizeConfigure({
        sessionId, role: kernel.row(sessionId).role, operation, generation,
      });
      if (!accepted) return yield* new AgentFailure({ operation: "session.configure", cause: "denied" });
      const current = kernel.row(sessionId);
      const previous = kernel.latestGenerationFor(sessionId);
      if (previous.generation !== before.generation)
        return yield* new AgentFailure({ operation: "session.configure", cause: "stale" });
      const snapshot = SessionHandleStore.generationSnapshot({
        generation, revertTo: previous.generation, tools: nextTools,
        system: nextSystem, policyGeneration: previous.policyGeneration,
        bundles: previous.bundles,
      });
      const configured = SessionHandleStore.configureAction({
        id: entropy(), sessionId, parentId: kernel.latestAction(sessionId)?.id ?? null,
        operation, snapshot, at: clock(),
      });
      const commit = commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [configured], state: current.state,
        generation: { toolsGeneration: snapshot.generation, systemHash: snapshot.systemHash, policyGeneration: snapshot.policyGeneration },
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      const committed = yield* runtime.generations.configure({ sessionId, generation }, snapshot, commit);
      yield* ports.hibernate(committed.row);
      return { generation: snapshot.generation, revertTo: snapshot.revertTo };
    });
  }

  return { configure };
}

// ─── from session-generations.ts (#1247) ───
export interface GenerationBundle {
  readonly id: SessionGeneration.Id;
  readonly snapshot: SessionGeneration.Snapshot;
  readonly layer: Layer.Layer<GenerationServices, SessionError>;
  /** Infallible synchronous gate flip, only after durable selection commits. */
  readonly activate: Effect.Effect<void>;
}

interface Entry {
  readonly bundle: GenerationBundle;
  readonly context: Context.Context<GenerationServices>;
  readonly scope: Scope.Closeable;
  readonly owners: ReturnType<typeof createRawSlots>;
  readonly hash: string;
  retired: boolean;
  closed: boolean;
}

/** One process-retained owner per session; closed entries remain tombstones. */
export function makeSessionGenerations(initial: GenerationBundle) {
  return Effect.gen(function* () {
    const processScope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const first = yield* acquire(initial);
    yield* initial.activate;
    const entries = new Map([[initial.id.generation, first]]);
    let current = first;
    let stopping = false;

    const close = (entry: Entry) => Effect.uninterruptible(Effect.gen(function* () {
      yield* entry.owners.awaitSettled;
      if (entry.closed) return;
      entry.closed = true;
      yield* Scope.close(entry.scope, Exit.void);
    }));
    const retire = (entry: Entry) => Effect.gen(function* () {
      if (entry.retired) return;
      entry.retired = true;
      if (entry.owners.pending() === 0) yield* close(entry);
      else yield* Effect.forkIn(close(entry), processScope);
    });
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      stopping = true;
      yield* Effect.forEach(entries.values(), close, { discard: true });
    }));

    function validate(bundle: GenerationBundle): Effect.Effect<void, SessionError> {
      return bundle.id.sessionId !== initial.id.sessionId || bundle.id.generation !== bundle.snapshot.generation
        ? Effect.fail(new AgentFailure({ operation: "generation.identity", cause: "snapshot_identity_mismatch" }))
        : Effect.void;
    }

    /** A known entry is capturable only while its snapshot matches and it still has live owners or is current. */
    function admitCapture(bundle: GenerationBundle, entry: Entry | undefined): Effect.Effect<void, SessionError> {
      if (stopping) return Effect.fail(new GenerationUnavailable({ generation: bundle.id.generation }));
      if (entry === undefined) return Effect.void;
      if (entry.hash !== snapshotHash(bundle.snapshot))
        return Effect.fail(new AgentFailure({ operation: "generation.capture", cause: "snapshot_hash_mismatch" }));
      if (entry.closed || (entry.retired && entry.owners.pending() === 0))
        return Effect.fail(new GenerationUnavailable({ generation: bundle.id.generation }));
      return Effect.void;
    }

    function capture(bundle = current.bundle): Effect.Effect<CapturedGeneration, SessionError, Scope.Scope> {
      return lock.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        yield* validate(bundle);
        let entry = entries.get(bundle.id.generation);
        yield* admitCapture(bundle, entry);
        if (entry === undefined) {
          entry = yield* restore(acquire(bundle));
          yield* bundle.activate;
          entries.set(bundle.id.generation, entry);
        }
        const release = entry.owners.open();
        yield* Effect.addFinalizer(() => Effect.sync(release));
        const captured = entry;
        if (captured.bundle.id.generation < current.bundle.id.generation) yield* retire(captured);
        const ownership: CapturedGeneration = {
          id: captured.bundle.id,
          snapshot: captured.bundle.snapshot,
          isSelected: () => captured === current,
          retain: () => captured.owners.open(),
          provide: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.provide(work, context),
        };
        const context = captured.context.pipe(Context.add(GenerationRawSlots, captured.owners), Context.add(GenerationOwnership, ownership));
        return ownership;
      })));
    }

    function configure<A>(bundle: GenerationBundle, commit: Effect.Effect<A, SessionError>) {
      return lock.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        yield* validate(bundle);
        if (stopping || entries.has(bundle.id.generation))
          return yield* new GenerationUnavailable({ generation: bundle.id.generation });
        const candidate = yield* restore(acquire(bundle));
        const receipt = yield* commit.pipe(Effect.onError((cause) => Scope.close(candidate.scope, Exit.failCause(cause))));
        yield* bundle.activate;
        const previous = current;
        entries.set(bundle.id.generation, candidate);
        current = candidate;
        yield* retire(previous);
        return receipt;
      })));
    }

    /**
     * Awaits every entry's live owners without flipping `stopping` (W5.2 S4):
     * shutdown interrupts live turns first, then settles here so the
     * fail-fast `drain` observes zero owners. Loops because a detached turn
     * unwinding may briefly hand its capture to a successor entry.
     */
    const settle: Effect.Effect<void> = Effect.suspend(() => {
      const pending = [...entries.values()].filter((entry) => entry.owners.pending() > 0);
      if (pending.length === 0) return Effect.void;
      return Effect.forEach(pending, (entry) => entry.owners.awaitSettled, { discard: true }).pipe(
        Effect.andThen(Effect.suspend(() => settle)),
      );
    });
    const drain = lock.withPermits(1)(Effect.gen(function* () {
      stopping = true;
      for (const entry of entries.values()) {
        if (entry.owners.pending() > 0) return yield* new GenerationUnsettled({
          ...entry.bundle.id, owners: entry.owners.pending(),
        });
      }
      yield* Effect.forEach(entries.values(), retire, { discard: true });
    }));
    return { capture, configure, drain, settle };
  });
}

function snapshotHash(snapshot: SessionGeneration.Snapshot): string {
  return canonicalDigest(PlainValueSchema.parse(snapshot));
}

function acquire(bundle: GenerationBundle): Effect.Effect<Entry, SessionError> {
  return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* restore(Layer.buildWithScope(bundle.layer, scope)).pipe(
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
    return { bundle, context, scope, owners: createRawSlots(), hash: snapshotHash(bundle.snapshot), retired: false, closed: false };
  }));
}

// ─── from session-outbound.ts (#1247) ───
function outboundOpen(
  message: SessionTransition.OutboundMessage,
  at: number,
): LedgerAction.Append {
  return {
    id: `${message.sourceActionId}:outbound`,
    parentId: message.sourceActionId,
    sessionId: message.sourceSessionId,
    kind: "outbound",
    intent: { encodingVersion: 1, value: { op: "open", message: PlainValueSchema.parse(message) } },
    effect: {
      encodingVersion: 1,
      value: {
        outbound: {
          message: PlainValueSchema.parse(message),
          state: "pending",
          destinationReceipt: null,
        },
      },
    },
    ts: at,
    irreversible: true,
  };
}

function toolsGeneration(kernel: SessionKernel, message: SessionTransition.OutboundMessage): number {
  const terminal = SessionHandleStore.turnTerminal(kernel.actionById(message.sourceActionId));
  const intent =
    terminal === undefined
      ? undefined
      : SessionHandleStore.turnIntent(kernel.actionById(terminal.turnId));
  if (intent === undefined) throw new AgentInvariantViolation("outbound original turn is missing");
  return intent.toolsGeneration;
}

function acknowledge(
  message: SessionTransition.OutboundMessage,
  receipt: LedgerAction.Receipt,
  at: number,
): LedgerAction.Append {
  const effect = receipt.action.effect.value;
  const answer =
    effect !== null && typeof effect === "object" && !Array.isArray(effect)
      ? SessionTransition.Answer.safeParse(effect.answer)
      : undefined;
  const payload =
    answer?.success === true && answer.data.outbound !== undefined
      ? PlainValueSchema.parse(answer.data.outbound)
      : receipt.action.intent.value;
  if (
    receipt.action.sessionId !== message.destinationSessionId ||
    canonicalDigest(payload) !== canonicalDigest(PlainValueSchema.parse(message))
  ) {
    throw new AgentInvariantViolation("outbound destination receipt does not match its recorded payload");
  }
  return {
    id: `${message.messageId}:ack`,
    parentId: `${message.sourceActionId}:outbound`,
    sessionId: message.sourceSessionId,
    kind: "outbound",
    intent: { encodingVersion: 1, value: { op: "ack", messageId: message.messageId } },
    effect: {
      encodingVersion: 1,
      value: {
        outbound: {
          message: PlainValueSchema.parse(message),
          state: "delivered",
          destinationReceipt: { id: receipt.action.id, revision: receipt.revision },
        },
      },
    },
    ts: at,
    irreversible: true,
  };
}

/** Drains recorded source obligations. It never seals again or writes a destination session. */
export function dispatchSessionOutbound(
  kernel: SessionKernel,
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  owner: string,
  fence: number,
  clock: () => number,
): Effect.Effect<void, SessionError> {
  return Effect.suspend(() => {
    const commit = (actions: LedgerAction.Append[]) => Effect.suspend(() => {
      const row = kernel.row(sessionId);
      return kernel.commit({
        sessionId, owner, fence, now: clock(), expectedRevision: row.revision,
        actions, state: row.state,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid);
    });
    return Effect.forEach(kernel.outboundRows(sessionId), (item) => Effect.scoped(Effect.gen(function* () {
      if (item.state === "delivered") return;
      // The receiver's durable commit is the proof, not a second dispatch. This
      // also works after it consumed the prompt and the sender lost the ACK.
      const received = kernel.outboundReceipt(
        item.message.destinationSessionId, item.message.messageId,
      );
      if (received !== undefined) {
        yield* commit([acknowledge(item.message, received, clock())]);
        return;
      }
      if (runtime.dispatchOutbound === undefined)
        return yield* Effect.die(new Error("outbound receiving consumer is unavailable"));
      const captured = yield* runtime.generations.capture({ sessionId, generation: toolsGeneration(kernel, item.message) });
      const receipt = yield* captured.provide(runtime.dispatchOutbound({
        message: item.message,
        authority: { owner, fence },
      })).pipe(Effect.provide(runtime.services));
      yield* commit([acknowledge(item.message, receipt, clock())]);
    })), { discard: true });
  });
}

// ─── from session-stop-evidence.ts (#1247) ───
export function sessionStopEvidence(
  kernel: SessionKernel,
  sessionId: string,
  turnId: string,
  approvals: () => ExecutionApprovals | undefined,
  openIntent?: SessionRuntime["openIntent"],
): NonNullable<ChatAgentConfig["stopEvidence"]> {
  let ordinal = kernel.row(sessionId).revision;
  const start = kernel.actionById(turnId)?.ordinal ?? ordinal;
  return () => Effect.gen(function* () {
    const revision = kernel.row(sessionId).revision;
    let progress = false;
    let blocked = false;
    while (ordinal < revision) {
      const page = kernel.historyPage(sessionId, { afterRevision: ordinal, limit: 256 });
      for (const action of page.actions) {
        if (action.ordinal > revision) break;
        progress ||= effectChanged(action);
        blocked ||= effectBlocked(action);
        ordinal = action.ordinal;
      }
    }
    const obligations = yield* (openIntent?.({ sessionId, turnId, revision }) ?? Effect.succeed([]));
    const pending = approvals()?.pending() ?? [];
    return {
      progress, blocked,
      openIntent: [...obligations.map((intent) => intent.actionId), ...pending.map((approval) => approval.id)],
      alarmIds: openAlarmIds(kernel, sessionId, start, revision),
    };
  });
}

/**
 * Live wait evidence is a chain fold (the alarm table is gone): every
 * `alarm.arm` action committed after this turn opened whose alarm no later
 * `alarm.fired`/`alarm.paused` child settled is still armed.
 */
function openAlarmIds(
  kernel: SessionKernel,
  sessionId: string,
  start: number,
  revision: number,
): string[] {
  const armed = new Map<string, string>();
  let cursor = start;
  while (cursor < revision) {
    const page = kernel.historyPage(sessionId, { afterRevision: cursor, limit: 256 });
    for (const action of page.actions) {
      if (action.ordinal > revision) break;
      if (action.kind === "alarm.arm") armed.set(action.id, action.id);
      if ((action.kind === "alarm.fired" || action.kind === "alarm.paused") && action.parentId !== null)
        armed.delete(action.parentId);
      cursor = action.ordinal;
    }
    if (page.nextRevision === null) break;
  }
  return [...armed.keys()];
}

function effectBlocked(action: LedgerAction.Node): boolean {
  const effect = action.effect.value;
  const intent = action.intent.value;
  if (action.kind === "policy.decision" && intent !== null && typeof intent === "object" && !Array.isArray(intent) && intent.verdict === "deny" && (intent.hook === "tool.pre" || intent.hook === "tool.post")) return true;
  return action.kind === "tool" && effect !== null && typeof effect === "object" && !Array.isArray(effect) && (effect.terminal === "blocked_pre" || effect.terminal === "blocked_post" || effect.terminal === "failed");
}

function effectChanged(action: LedgerAction.Node): boolean {
  if (action.kind === "session.configure" || action.kind === "alarm.arm" || action.kind === "inbox.deliver") return true;
  const effect = action.effect.value;
  return effect !== null && typeof effect === "object" && !Array.isArray(effect) && effect.stateChanged === true;
}

// ─── from session-turn.ts (#1247) ───
const ExternalOrigin = z.object({ kind: z.literal("external") });
const FullAccessOrigin = ExternalOrigin.extend({ inboundTreatment: z.literal("full_access") });
const EvidenceOnlyOrigin = ExternalOrigin.extend({ inboundTreatment: z.literal("evidence_only") });
const SessionOrigin = z.object({ kind: z.literal("session"), id: z.string() });
/** Provenance this kernel minted itself: session handles, inter-session mail, reply terminals. */
const TrustedOrigin = z.union([SessionOrigin, Inbox.MessageOrigin, Inbox.ReplyOrigin]);

/** The violation fact published when mail of unknown provenance reaches a turn. */
export const InboundAuthorityViolated = BusEvent.define(
  "session.inbound_authority.violation",
  z.object({
    reason: z.enum(["unknown_origin", "undeclared_treatment"]),
    messageId: z.string().optional(),
  }),
  { visibility: "user_audit" },
);

export interface InboundAuthorityDecision {
  readonly authority: "act" | "evidence_only";
  readonly violation?: InboundAuthorityViolation;
}

/**
 * Turn authority from the prompt's inbox origin. A missing origin (fixture
 * prompt) or a kernel-minted origin acts; an external origin acts only when
 * the perimeter recorded `full_access` verbatim, and is evidence when it
 * recorded `evidence_only`. Everything else is mail of unknown provenance:
 * evidence authority plus a recorded violation fact — never `act`.
 */
export function inboundAuthority(origin: PlainValue | undefined): InboundAuthorityDecision {
  if (origin === undefined || TrustedOrigin.safeParse(origin).success) return { authority: "act" };
  if (ExternalOrigin.safeParse(origin).success) {
    if (FullAccessOrigin.safeParse(origin).success) return { authority: "act" };
    if (EvidenceOnlyOrigin.safeParse(origin).success) return { authority: "evidence_only" };
    return { authority: "evidence_only", violation: new InboundAuthorityViolation("undeclared_treatment") };
  }
  return { authority: "evidence_only", violation: new InboundAuthorityViolation("unknown_origin") };
}

/** The turn's result when the runner never produced one: a typed missing-output failure, not a policy refusal. */
export function runnerOutputMissingResult(turnId: string): SessionRunnerResult {
  const cause = new RunnerOutputMissing(turnId);
  return { kind: "error", text: cause.message, cause };
}

interface TurnInput {
  readonly turnId: string;
  readonly resultId: string;
  readonly parentActionId: string;
  readonly boundaryActionId: string | null;
  readonly resumeCount: number;
  readonly generation: SessionGeneration.Snapshot;
  readonly resume: boolean;
}

export function createSessionTurn(
  kernel: SessionKernel,
  sessionId: string,
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  scope: Scope.Scope,
  ports: {
    readonly createExecutionLedger: (turnId?: string) => SessionActionCommitPort;
    readonly evaluatePromptPolicies: (items: readonly Inbox.Row[]) => Effect.Effect<SessionPolicyRefusal | undefined, ExecutionError, RunnerServices>;
    readonly consumePolicyBlockedInbox: (items: readonly Inbox.Row[]) => Effect.Effect<void, ExecutionError>;
    readonly hibernate: (current: LedgerSession.Row) => Effect.Effect<void, SessionError>;
  },
) {
  function runTurn(input: TurnInput): Effect.Effect<SessionRunnerResult, SessionError> {
    return Effect.scoped(Effect.gen(function* () {
      const captured = yield* runtime.generations.capture({ sessionId, generation: input.generation.generation });
      const ownership = { ...captured, retain() {
        const generation = captured.retain();
        const session = state.rawSlots.open();
        return () => { generation(); session(); };
      } };
      return yield* captured.provide(runCaptured(input).pipe(Effect.provideService(GenerationOwnership, ownership))).pipe(Effect.provide(runtime.services));
    }));
  }

  function runCaptured(input: TurnInput): Effect.Effect<SessionRunnerResult, SessionError, RunnerServices> {
    return Effect.gen(function* () {
      const services = yield* Effect.context<RunnerServices>();
      const row = kernel.row(sessionId);
      const controller = new AbortController();
      state.controller = controller;
      let parentActionId = input.parentActionId;
      let boundaryActionId = input.boundaryActionId;
      const ledger = ports.createExecutionLedger(input.turnId);
      const retainEffect = (raw: Promise<void>) => {
        const settle = state.rawSlots.open();
        void raw.then(settle);
      };
      const execution = yield* createExecutor({
        retryAlarm: runtime.retryAlarm, signal: controller.signal, retainEffect,
        closeGraceMs: runtime.closeGraceMs, ledger,
        identity: { sessionId, role: row.role, parentActionId: input.turnId },
      });
      const boundary = (kind: SessionTurn.Boundary): Effect.Effect<SessionBoundaryResult, ExecutionError> => Effect.gen(function* () {
        if (controller.signal.aborted) return { messages: [], interrupted: true };
        const drained = yield* drainBoundary(input, kind, parentActionId);
        parentActionId = drained.parentActionId;
        boundaryActionId = drained.boundaryActionId;
        if (drained.interrupted) controller.abort();
        return { messages: drained.messages, interrupted: drained.interrupted };
      }).pipe(Effect.provide(services));
      let runnerResult: SessionRunnerResult = runnerOutputMissingResult(input.turnId);
      const body = Effect.gen(function* () {
        if (controller.signal.aborted) return yield* Effect.interrupt;
        const hydrated = hydrateSessionHistory(kernel, sessionId);
        const promptId = hydrated.messages.filter((message) => message.role === "user").at(-1)?.id;
        const origin = receivedMessages(kernel, sessionId).rows.find((item) => item.id === promptId)?.origin;
        const inbound = inboundAuthority(origin?.value);
        if (inbound.violation !== undefined) {
          const observations = yield* ObservationService;
          scopeObservation(observations, { sessionId, turnId: input.turnId }, { now: clock, id: entropy }).publish(
            InboundAuthorityViolated,
            { reason: inbound.violation.reason, ...(promptId === undefined ? {} : { messageId: promptId }) },
          );
        }
        runnerResult = yield* runner({
          authority: inbound.authority,
          sessionId, kernel, role: row.role, turnId: input.turnId, actionId: input.parentActionId,
          ledger, retainEffect, bindApprovals: (approvals) => { state.activeApprovals = approvals; },
          stopEvidence: sessionStopEvidence(kernel, sessionId, input.turnId, () => state.activeApprovals, runtime.openIntent),
          resultId: input.resultId, parentActionId, boundaryActionId,
          messages: hydrated.messages,
          history: hydrated.history,
          tools: input.generation.tools, toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          system: input.generation.systemValue, systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration,
          resumeCount: input.resumeCount, signal: controller.signal, boundary,
        });
        return sessionRunnerResultValue(runnerResult);
      });
      const work = execution.runExisting({
        kind: "turn", op: "session",
        intent: {
          turnId: input.turnId, resultId: input.resultId, resumeCount: input.resumeCount, resume: input.resume,
          toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration,
        }, effect: { terminal: "sealed" },
      }, () => withSignal(body, controller.signal));
      const exit = yield* Effect.exit(work);
      const result = resultOf(exit, runnerResult);
      if (state.controller === controller) state.controller = undefined;
      // A raw slot, unlike its fiber, can outlive interruption. Its generation
      // remains owned by the app Scope until actual raw settlement.
      const retained = state.rawSlots.pending() > 0;
      if (!state.terminalFrozen) {
        const latestAction = kernel.latestAction(sessionId);
        if (latestAction === undefined) return yield* Effect.die(new Error(`session tree is empty: ${sessionId}`));
        yield* seal({
          turnId: input.turnId, resultId: input.resultId, resumeCount: input.resumeCount, boundaryActionId,
          toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration, action: latestAction,
        }, result);
      }
      if (retained) {
        state.retainedRunner = yield* Effect.forkIn(state.rawSlots.awaitSettled.pipe(
          Effect.onExit(() => Effect.gen(function* () {
            state.retainedRunner = undefined;
            yield* ports.hibernate(kernel.row(sessionId)).pipe(Effect.orDie);
          })),
        ), scope);
      }
      return result;
    });
  }

  function drainBoundary(input: TurnInput, boundary: SessionTurn.Boundary, parentActionId: string) {
    return Effect.gen(function* () {
      const observations = yield* ObservationService;
      const pending = pendingBacklog(kernel, sessionId);
      const refusal = yield* ports.evaluatePromptPolicies(pending);
      if (refusal !== undefined) {
        yield* ports.consumePolicyBlockedInbox(pending);
        return yield* new AgentFailure({ operation: "session.prompt", cause: refusal.reason });
      }
      const checkpointId = entropy();
      const deliveries = deliveryActions(
        pending,
        { kind: "turn", turnId: input.turnId },
        boundary,
        checkpointId,
      );
      const checkpoint = turnCheckpointAction({
        id: checkpointId, parentId: parentActionId, sessionId, turnId: input.turnId, resultId: input.resultId,
        resumeCount: input.resumeCount, boundaryActionId: checkpointId, boundary, at: clock(),
      });
      const current = kernel.row(sessionId);
      yield* commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [checkpoint, ...deliveries],
        state: current.state === "interrupted" ? "interrupted" : "running",
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      observeDrained(pending, input.turnId, boundary, clock(), observations, entropy);
      return {
        messages: pending.filter((item) => item.kind === "prompt").map((item) => ({ id: item.id, role: "user" as const, text: item.content })),
        interrupted: pending.some((item) => item.kind === "interrupt"),
        parentActionId: deliveries.at(-1)?.id ?? checkpointId, boundaryActionId: checkpointId,
      };
    });
  }

  function seal(open: SessionHandleStore.OpenTurn, result: SessionRunnerResult): Effect.Effect<void, SessionError> {
    return Effect.gen(function* () {
      const current = kernel.row(sessionId);
      const latest = kernel.latestAction(sessionId);
      const interrupts = result.kind === "interrupted" ? pendingBacklog(kernel, sessionId).filter((item) => item.kind === "interrupt") : [];
      const deliveries = deliveryActions(
        interrupts,
        { kind: "turn", turnId: open.turnId },
        "before_llm",
        latest?.id ?? open.action.id,
      );
      const terminal = turnTerminalAction({
        id: open.resultId, parentId: deliveries.at(-1)?.id ?? latest?.id ?? open.action.id,
        sessionId, turnId: open.turnId, result, resumeCount: open.resumeCount, boundaryActionId: open.boundaryActionId, at: clock(),
      });
      const reply = parentReply(kernel, current, terminal, result);
      yield* commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [...deliveries, terminal, ...(reply === undefined ? [] : [outboundOpen(reply, terminal.ts)])],
        state: result.kind === "interrupted" ? "interrupted" : "idle",
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      observeDrained(interrupts, open.turnId, "before_llm", clock(), runtime.observations, runtime.entropy);
      if (reply !== undefined) yield* dispatchSessionOutbound(kernel, sessionId, runtime, owner, state.fence, clock);
    });
  }
  return { runTurn, seal };
}

function withSignal<A, E, R>(work: Effect.Effect<A, E, R>, signal: AbortSignal) {
  return work.pipe(Effect.raceFirst(interruptOn(signal)));
}

function resultOf(exit: Exit.Exit<ExecutionResult, ExecutionError>, value: SessionRunnerResult): SessionRunnerResult {
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterrupts(exit.cause)) return { kind: "interrupted", text: "" };
    const cause = Failure.of(exit.cause, "session.turn");
    return { kind: "error", text: cause.message, cause };
  }
  const outcome = exit.value;
  if (outcome.terminal !== "executed") return policyRefusalResult(outcome.reason);
  if (canonicalDigest(outcome.value) === canonicalDigest(sessionRunnerResultValue(value))) return value;
  return sessionRunnerResultFromValue(outcome.value) ?? policyRefusalResult("invalid_output");
}

// ─── from session-chat-runner.ts (#1247) ───
interface SessionChatRun {
  readonly config: ChatAgentConfig & { readonly executor: Executor };
  readonly traceContext: TraceContext.Type;
  readonly around?: (operation: Effect.Effect<AgentResult, ExecutionError, RunnerServices>) => Effect.Effect<AgentResult, ExecutionError, RunnerServices>;
}

interface SessionChatRunnerOptions {
  readonly prepare: (input: SessionRunnerInput) => Effect.Effect<SessionChatRun, ExecutionError, RunnerServices>;
  readonly reportError?: (error: Error, input: SessionRunnerInput) => string | undefined;
}

export function createSessionChatRunner(options: SessionChatRunnerOptions): SessionRunner {
  return (input) => Effect.gen(function* () {
    const messages = input.messages.map((message) => ({ role: message.role, content: message.text, id: message.id }));
    const prepared = yield* options.prepare(input);
    const executor = prepared.config.executor;
    if (executor.recover === undefined || executor.runAttempts === undefined || executor.judgeStop === undefined)
      return yield* Effect.die(new Error("durable chat runner requires session authority"));
    const captured = hydrateSessionHistory(input.kernel, input.sessionId);
    yield* executor.recover();
    const refreshed = refreshSessionHistory(input.kernel, input.sessionId, captured);
    const operation = runAgent({
      messages,
      history: refreshed.history,
      traceContext: prepared.traceContext,
    }, {
      ...prepared.config,
      pinnedModel: pinnedModelSelection(input.kernel, input.sessionId, input.turnId),
      execution: { runAttempts: executor.runAttempts, judgeStop: executor.judgeStop },
      signal: input.signal,
      boundary: input.boundary,
      stopEvidence: input.stopEvidence,
    });
    const result = yield* (prepared.around?.(operation) ?? operation);
    if (result.waiting !== undefined) return { kind: "waiting", text: result.text, ...result.waiting } satisfies SessionRunnerResult;
    return { kind: "result", text: result.text, finishReason: result.finishReason, usage: result.usage } satisfies SessionRunnerResult;
  }).pipe(Effect.catch((error): Effect.Effect<SessionRunnerResult, ExecutionError> => {
    if (error._tag === "Interrupted" || (error._tag === "LlmRunFailure" && error.aborted))
      return Effect.succeed({ kind: "interrupted" } satisfies SessionRunnerResult);
    const reported = options.reportError?.(error, input);
    return reported === undefined ? Effect.fail(error) : Effect.succeed({
      kind: "error", text: reported, cause: error, reported: true,
    } satisfies SessionRunnerResult);
  }));
}

// ─── session handle plane seam (#1247): the registry lives in testing/ ───
/** A live in-process handle plane; only the testing registry installs one. */
export interface SessionHandlePlane {
  get(id: string): SessionHandle | undefined;
  close(): Effect.Effect<void, SessionError>;
}
const handlePlanes = new WeakMap<SessionRuntime, SessionHandlePlane>();
export function installSessionHandlePlane(runtime: SessionRuntime, plane: SessionHandlePlane): void {
  handlePlanes.set(runtime, plane);
}
export function getSessionHandle(id: string, runtime: SessionRuntime): SessionHandle | undefined {
  return handlePlanes.get(runtime)?.get(id);
}
export function closeSessions(runtime: SessionRuntime): Effect.Effect<void, SessionError> {
  return Effect.suspend(() => {
    const plane = handlePlanes.get(runtime);
    handlePlanes.delete(runtime);
    return plane === undefined ? Effect.void : plane.close();
  });
}
