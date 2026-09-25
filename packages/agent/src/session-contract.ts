import { Effect, type Context } from "effect";
import type { SessionError, ExecutionError } from "./errors";
import type { ExecutionLedger } from "./executor-contract";
import type { SessionHandleStore } from "@openomni/ledger";
import type {
  Inbox,
  LedgerAction,
  LedgerSession,
  ObservationSink,
  SessionGeneration,
  SessionHistory,
  SessionTurn,
  SessionTransition,
} from "@openomni/protocol";
import type { ChatAgentConfig } from "./core/types";
import type { ExecutionApprovals, ExecutionResult, ExecutorOptions } from "./executor";
import { Clock, Entropy, ObservationSink as ObservationService, GenerationLayers, type SessionEntryServices, type RunnerServices } from "./services";

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
      readonly cause?: Error;
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
  readonly onHibernate?: (sessionId: string) => Effect.Effect<void, ExecutionError>;
  /**
   * How long `close()` waits for an abort-ignoring runner to settle before
   * detaching the caller. Defaults to the lease TTL. Detaching only bounds the
   * caller-facing wait: the heartbeat keeps renewing and the lease is released
   * by the turn continuation once the runner actually settles, never handed
   * off while it may still be alive. `0` detaches immediately.
   */
  readonly closeGraceMs?: number;
}

/** Captured once by registry/request acquisition, never an alternate public service API. */
export interface ResolvedSessionRuntime extends SessionRuntime {
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly observations: ObservationSink;
  readonly generations: Context.Tag.Service<typeof GenerationLayers>;
  readonly services: Context.Context<SessionEntryServices>;
}

export function resolveSessionRuntime(runtime: SessionRuntime): Effect.Effect<ResolvedSessionRuntime, never, SessionEntryServices> {
  return Effect.gen(function* () {
    const services = yield* Effect.context<SessionEntryServices>();
    const clock = yield* Clock;
    const entropy = yield* Entropy;
    const observations = yield* ObservationService;
    const generations = yield* GenerationLayers;
    return { ...runtime, clock: clock.now, entropy: entropy.next, observations, generations, services };
  });
}

export interface SessionToolsHandle {
  add(tools: readonly SessionTool[]): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError>;
  remove(names: readonly string[]): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError>;
}

export interface SessionSystemBlocksHandle {
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
    ): Effect.Effect<import("./session-request").RequestDecision, ExecutionError>;
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
  inspect(request?: SessionHistory.InspectRequest): SessionHistory.Inspection;
  close(): Effect.Effect<void, SessionError>;
}

export class SessionPolicyRefusal extends Error {
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
