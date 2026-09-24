import type { LedgerError } from "@openomni/ledger";
import type { Effect, Scope } from "effect";
import type { RawToolSlots } from "./executor-raw";
import type { ExecutionError } from "./errors";
import type {
  BusEvent,
  LedgerAction,
  LedgerSession,
  ObservationSink,
  PlainValue,
  SessionTransition,
  Tool,
} from "@openomni/protocol";
import type { CompiledPolicySnapshot, PolicyEvaluationInput } from "@openomni/policy";
import type { RetryAlarmPort } from "./executor-retry-alarm";
import type { WaveControl } from "./core/execution/tool-wave";

interface ExecutionKindRegistration {
  readonly kind: string;
  readonly effect: PlainValue;
  readonly reversible: boolean;
  readonly inputSchema: PlainValue;
}

export interface ExecutionLedger {
  commit(action: LedgerAction.Append): Effect.Effect<LedgerAction.Receipt, LedgerError>;
  actionById?(id: string): LedgerAction.Node | undefined;
  requestById?(id: string): SessionTransition.Request | undefined;
  resultFor?(id: string): LedgerAction.Node | undefined;
  openOperationsPage?(turnId: string, cursor: number): readonly LedgerAction.Node[];
  operationChildrenPage?(parentId: string, cursor: number): readonly LedgerAction.Node[];
  guardedOperationsPage?(turnId: string, cursor: number): readonly LedgerAction.Node[];
  validateRequest?(request: SessionTransition.Request): boolean;
  transition?(
    payload: SessionTransition.Payload,
    inputId: string,
    at: number,
  ): Effect.Effect<import("./session-request").RequestDecision, ExecutionError>;
}

interface ExecutionIdentity {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly parentActionId: string | null;
  readonly turnId?: string;
  readonly toolsHash?: string;
  readonly toolsGeneration?: number;
  readonly systemHash?: string;
}

interface ToolObservationIdentity {
  readonly turnId: string;
  readonly callId: string;
  readonly timeoutMs?: number;
}

/** How an interrupted effect may be settled from evidence; nothing here permits a replay. */
export type RecoveryClassification =
  | "local_transactional"
  | "endpoint_idempotent"
  | "read_back_reconcilable"
  | "ambiguous_no_replay";

export interface ExecutionRequest {
  readonly kind: string;
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
  /** Recorded on the intent so crash-open recovery classifies from durable evidence. */
  readonly recovery?: RecoveryClassification;
  readonly message?: PolicyEvaluationInput["message"];
  readonly revert?: () => Effect.Effect<void, ExecutionError>;
  /** Result-dependent evidence for a reversible durable projection. */
  readonly revertData?: () => PlainValue | undefined;
  /**
   * Commit the settled value as a durable boundary child action (one ledger
   * transaction) before the result commit and any publication: a crash after
   * the boundary recovers the executed value without re-running the body.
   */
  readonly boundary?: boolean;
  readonly toolObservation?: ToolObservationIdentity;
  /** Model-facing settlement, committed atomically with the tool's effect evidence. */
  readonly toolResult?: (outcome: ExecutionBatchResult) => Tool.Result;
  readonly approval?: {
    readonly required: boolean;
    readonly domainRevisions: Readonly<Record<string, number>>;
    readonly timeoutMs?: number;
  };
  readonly domainRevisions?: () => Readonly<Record<string, number>>;
  readonly originalAction?: LedgerAction.Node;
}

export interface AttemptRequest {
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
}

export interface LlmAttempts<T extends PlainValue> {
  prepare(
    attempt: number,
    failureReasons: readonly string[],
  ): Effect.Effect<{
    readonly request: AttemptRequest;
    readonly fallbackAvailable?: boolean;
    admit(): Effect.Effect<void, ExecutionError>;
    body(): Effect.Effect<T, ExecutionError>;
  }, ExecutionError>;
  recoverOverflow?(error: ExecutionError): Effect.Effect<boolean, ExecutionError>;
  /** Durable attempt evidence (usage, visible-output boundary, credential handle) projected from a settled body. */
  evidence?(value: T): PlainValue;
  onRetry?(decision: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly decision: import("@openomni/llm").Retry.Decision;
    readonly error: Error;
    readonly reason: string;
  }): void;
}

export type ExecutionResult =
  | { readonly terminal: "blocked_pre"; readonly reason: string }
  | { readonly terminal: "executed"; readonly value: PlainValue; readonly failure?: ExecutionError }
  | { readonly terminal: "interrupted"; readonly reason: string }
  | { readonly terminal: "outcome_unknown"; readonly reason: string }
  | {
      readonly terminal: "blocked_post";
      readonly disposition: "reverted" | "irreversible";
      readonly reason: string;
    };

export interface ExecutionApprovalRequest {
  readonly durable: SessionTransition.Request;
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly callId: string;
  readonly inputHash: string;
  readonly expiresAt?: number;
  readonly generation: number;
  readonly revision: number;
  readonly policyDecisionId: string;
  readonly toolsHash?: string;
  readonly toolsGeneration?: number;
  readonly intent: PlainValue;
}

interface ExecutionApprovalAnswer {
  readonly request: ExecutionApprovalRequest;
  readonly decision: "approve" | "refuse";
  readonly credential: string;
}

interface OwnerApprovalEvidence {
  readonly kind: "owner";
  readonly principalId: string;
  readonly evidenceId: string;
}

export interface ExecutionApprovals {
  pending(): readonly ExecutionApprovalRequest[];
  answer(answer: ExecutionApprovalAnswer): Effect.Effect<void, ExecutionError>;
  notify?(request: SessionTransition.Request): void;
}

export interface ExecutionBatchItem<R = never> {
  readonly request: ExecutionRequest;
  readonly sequential?: true;
  body(intent: LedgerAction.Receipt, admittedInput: PlainValue): Effect.Effect<PlainValue, ExecutionError, R>;
}
export type ExecutionBatchResult = ExecutionResult;

export interface Executor {
  recover?(): Effect.Effect<void, ExecutionError>;
  runAttempts?<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    attempts: LlmAttempts<T>,
  ): Effect.Effect<T, ExecutionError>;
  readonly judgeStop?: DurableExecutor["judgeStop"];
  readonly approvals?: ExecutionApprovals;
  runBatch?<R>(
    items: readonly ExecutionBatchItem<R>[],
    control: WaveControl,
  ): Effect.Effect<readonly ExecutionBatchResult[], ExecutionError, Exclude<R, RawToolSlots | Scope.Scope>>;
  run<T extends PlainValue, R>(
    request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt, admittedInput: PlainValue) => Effect.Effect<T, ExecutionError, R>,
  ): Effect.Effect<ExecutionResult, ExecutionError, Exclude<R, RawToolSlots | Scope.Scope>>;
}

export interface DurableExecutor extends Executor {
  recover(): Effect.Effect<void, ExecutionError>;
  runBatch<R>(
    items: readonly ExecutionBatchItem<R>[],
    control: WaveControl,
  ): Effect.Effect<readonly ExecutionBatchResult[], ExecutionError, Exclude<R, RawToolSlots | Scope.Scope>>;
  judgeStop(
    state: import("./core/execution/stop-chain").StopState,
    observation: import("./core/execution/stop-chain").StopObservation,
  ): Effect.Effect<{
    state: import("./core/execution/stop-chain").StopState;
    verdict: import("./core/execution/stop-chain").StopVerdict;
  }, ExecutionError>;
  runExisting<T extends PlainValue, R>(
    request: ExecutionRequest,
    body: () => Effect.Effect<T, ExecutionError, R>,
  ): Effect.Effect<ExecutionResult, ExecutionError, R>;
  runAttempts<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    attempts: LlmAttempts<T>,
  ): Effect.Effect<T, ExecutionError>;
}

export interface ExecutorOptions {
  /** Durable retry schedule port; the default commits through the single alarm owner. */
  readonly retryAlarm?: RetryAlarmPort;
  readonly signal?: AbortSignal;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly closeGraceMs?: number;
  readonly approvalTimeoutMs?: number;
  readonly ledger: ExecutionLedger;
  readonly identity: ExecutionIdentity;
  readonly extensionKinds?: readonly ExecutionKindRegistration[];
  readonly authorizeApproval?: (
    credential: string,
    request: ExecutionApprovalRequest,
  ) => Effect.Effect<OwnerApprovalEvidence, ExecutionError>;
}

/** Package-private resolved values; public acquisition accepts no service options. */
export interface ResolvedExecutorOptions extends ExecutorOptions {
  readonly policy: CompiledPolicySnapshot;
  readonly observations: ObservationSink | BusEvent.Sink;
  readonly clock: () => number;
  readonly entropy: () => string;
}
