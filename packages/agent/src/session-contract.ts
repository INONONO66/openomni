import type { SessionHandleStore } from "@openomni/ledger";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type {
  Inbox,
  LedgerAction,
  LedgerSession,
  ObservationSink,
  SessionGeneration,
  SessionTurn,
} from "@openomni/protocol";
import type { ChatAgentConfig } from "./core/types";
import type { ExecutionApprovals, ExecutorOptions } from "./executor";

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
}

interface SessionGetOptions {
  readonly turns?: number;
}

export interface SessionActionCommitPort {
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
  readonly boundary: (boundary: SessionTurn.Boundary) => Promise<SessionBoundaryResult>;
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

export type SessionRunner = (input: SessionRunnerInput) => Promise<SessionRunnerResult>;

export interface SessionRuntime {
  /** L1 admits the terminal letter through gateway.ingest, then atomically commits it with this terminal. */
  readonly commitTerminal?: (input: {
    readonly commit: LedgerSession.Commit;
    readonly reply: Inbox.Commit;
    readonly policy: CompiledPolicySnapshot;
  }) => Promise<LedgerSession.CommitResult>;
  /** Direct post-commit doorbells, independent of the lossy observation bus. */
  readonly onInboxCommitted?: (sessionIds: readonly string[]) => void;
  readonly openIntent?: (input: {
    sessionId: string;
    turnId: string;
    revision: number;
  }) => Promise<readonly { actionId: string; kind: "message" | "approval" }[]>;
  readonly waitRetry?: ExecutorOptions["waitRetry"];
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

export class SessionLeaseError extends Error {
  constructor(readonly result: Exclude<LedgerSession.LeaseResult, { readonly ok: true }>) {
    super(`session lease ${result.reason}`);
    this.name = "SessionLeaseError";
  }
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
  reconcile(): Promise<SessionRunnerResult | undefined>;
  isRunning(): boolean;
}

export interface RegistryEntry {
  readonly runner: SessionRunner;
  readonly controller: SessionController;
}

export interface SessionControllerLifecycle {
  reactivate(): SessionHandle;
  release(): void;
}
