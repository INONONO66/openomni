import type {
  BusEvent,
  LedgerAction,
  LedgerSession,
  ObservationSink,
  PlainValue,
} from "@openomni/protocol";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { WaveControl } from "./core/execution/tool-wave";

interface ExecutionKindRegistration {
  readonly kind: string;
  readonly effect: PlainValue;
  readonly reversible: boolean;
  readonly inputSchema: PlainValue;
}

export interface ExecutionLedger {
  commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt>;
}

interface ExecutionIdentity {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly parentActionId: string | null;
  readonly turnId?: string;
  readonly toolsHash?: string;
  readonly toolsGeneration?: number;
}

interface ToolObservationIdentity {
  readonly turnId: string;
  readonly callId: string;
  readonly timeoutMs?: number;
}

export interface ExecutionRequest {
  readonly kind: string;
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
  readonly revert?: () => void | Promise<void>;
  /** Result-dependent evidence for a reversible durable projection. */
  readonly revertData?: () => PlainValue | undefined;
  readonly toolObservation?: ToolObservationIdentity;
}

export interface AttemptRequest {
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
}

export type ExecutionResult =
  | { readonly terminal: "blocked_pre"; readonly reason: string }
  | { readonly terminal: "executed"; readonly value: PlainValue }
  | {
      readonly terminal: "blocked_post";
      readonly disposition: "reverted" | "irreversible";
      readonly reason: string;
    };

export interface ExecutionApprovalRequest {
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
  answer(answer: ExecutionApprovalAnswer): Promise<void>;
}

export class ExecutionApprovalError extends Error {
  constructor(
    readonly code: "stale_approval" | "approval_authority_unavailable" | "unauthenticated",
  ) {
    super(code);
    this.name = "ExecutionApprovalError";
  }
}

export interface ExecutionBatchItem {
  readonly request: ExecutionRequest;
  readonly sequential?: true;
  body(intent: LedgerAction.Receipt): Promise<PlainValue>;
}
export type ExecutionBatchResult =
  | ExecutionResult
  | { readonly terminal: "cancelled" }
  | { readonly terminal: "failed"; readonly error: Error };

export interface Executor {
  readonly approvals?: ExecutionApprovals;
  runBatch?(
    items: readonly ExecutionBatchItem[],
    control: WaveControl,
  ): Promise<readonly ExecutionBatchResult[]>;
  run<T extends PlainValue>(
    request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt) => Promise<T>,
  ): Promise<ExecutionResult>;
}

export interface DurableExecutor extends Executor {
  runExisting<T extends PlainValue>(
    request: ExecutionRequest,
    body: () => Promise<T>,
  ): Promise<ExecutionResult>;
  runAttempt<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    request: AttemptRequest,
    body: () => Promise<T>,
  ): Promise<T>;
}

export interface ExecutorOptions {
  readonly approvalTimeoutMs?: number;
  readonly scheduleApprovalTimeout?: (expire: () => void, delayMs: number) => () => void;
  readonly policy: CompiledPolicySnapshot;
  readonly ledger: ExecutionLedger;
  readonly observations: ObservationSink | BusEvent.Sink;
  readonly identity: ExecutionIdentity;
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly extensionKinds?: readonly ExecutionKindRegistration[];
  readonly authorizeApproval?: (
    credential: string,
    request: ExecutionApprovalRequest,
  ) => Promise<OwnerApprovalEvidence>;
}
