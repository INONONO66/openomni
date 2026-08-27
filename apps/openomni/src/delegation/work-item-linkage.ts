import { WorkItemAttemptRun, WorkItemStore } from "@openomni/ledger";
import { Delegation, WorkItem, newTraceId } from "@openomni/protocol";

/**
 * The bridge between the delegation kernel and the WorkItem contract: every
 * admitted assign commissions a WorkItem with an allocated attempt, and every
 * settlement closes that attempt — demoting the worker's report to Evidence,
 * never to completion. Completion stays admission-only (docs/kernel-contract.md).
 */
export interface WorkItemLinkage {
  /** Commission the WorkItem and its attempt at admission. Returns the WorkItem id. */
  openAssign(input: OpenAssignInput): Promise<string>;
  /** Close the attempt from the settlement fold. Unknown items are a no-op. */
  closeAttempt(input: CloseAttemptInput): Promise<void>;
}

interface OpenAssignInput {
  readonly delegationId: string;
  readonly transport: Delegation.Transport;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  readonly sessionId: string;
}

interface CloseAttemptInput {
  readonly record: Delegation.Record;
  readonly settlement: Delegation.Settled;
}

export interface WorkItemLinkageOptions {
  readonly model: Readonly<{ provider: string; id: string }>;
  readonly now: () => number;
}

const NAME_BUDGET = 80;

/**
 * Assign never runs inline (protocol superRefine), so the executor is either
 * this host's own worker process or a perimeter actor — and perimeter actors
 * ride the human channel regardless of what answers on the other side.
 */
function executorKindOf(transport: Delegation.Transport): WorkItem.ExecutorKind {
  return transport === "channel" ? "human_channel" : "internal_chat_agent";
}

export function createWorkItemLinkage(options: WorkItemLinkageOptions): WorkItemLinkage {
  async function openAssign(input: OpenAssignInput): Promise<string> {
    const traceId = newTraceId();
    const name =
      input.instruction.length > NAME_BUDGET
        ? `${input.instruction.slice(0, NAME_BUDGET - 1)}…`
        : input.instruction;
    const item = await WorkItemStore.create(
      {
        name,
        sourceMessageId: input.delegationId,
        sourceChannel: "delegation",
        intent: input.instruction,
        goal: input.instruction,
        acceptanceCriteria: [...input.acceptanceCriteria],
        sessionId: input.sessionId,
      },
      traceId,
    );
    await WorkItemStore.assignExecution(
      item.workItemId,
      {
        executorKind: executorKindOf(input.transport),
        workerRunId: input.delegationId,
        workSessionId: input.sessionId,
      },
      traceId,
    );
    const allocated = await WorkItemStore.allocateAttempt(
      item.workItemId,
      {
        contentFingerprint: WorkItem.contentFingerprintOf({
          workInput: input.instruction,
          handlerKind: `delegation:${input.transport}`,
          handlerCodeRef: { absent: true, reason: "handler code identity not captured at delegation admission" },
          model: {
            provider: options.model.provider,
            id: options.model.id,
            parameters: { absent: true, reason: "provider defaults; no per-delegation overrides" },
          },
          upstreamFingerprints: { absent: true, reason: "a delegation attempt consumes no upstream attempts" },
          dependencyLock: { absent: true, reason: "dependency lock not captured at delegation admission" },
        }),
        environmentFingerprint: WorkItem.environmentFingerprintOf({
          os: process.platform,
          arch: process.arch,
          bunVersion: Bun.version,
          workspaceRoot: { absent: true, reason: "delegated work runs outside a fixed workspace" },
          schemaVersions: { delegation: 1, workItem: 1 },
          policy: { absent: true, reason: "no policy plan is bound at delegation admission" },
          toolVersions: { absent: true, reason: "worker tool catalog is resolved after admission" },
          verifierVersions: { absent: true, reason: "verification happens at completion admission, not here" },
          providerParameters: { absent: true, reason: "provider defaults; no per-delegation overrides" },
          configRef: { absent: true, reason: "config identity not captured at delegation admission" },
        }),
      },
      traceId,
    );
    if (allocated === undefined) {
      throw new Error(`WorkItem ${item.workItemId} refused an attempt at admission`);
    }
    return item.workItemId;
  }

  async function closeAttempt(input: CloseAttemptInput): Promise<void> {
    const { record, settlement } = input;
    if (record.workItemId === undefined || settlement.status === "sent") return;
    const item = await WorkItemStore.get(record.workItemId);
    // Unknown item: a legacy record upcast points at nothing durable — no-op.
    if (item === undefined || item.attemptTerminal !== undefined) return;
    const traceId = newTraceId();
    const completed = settlement.status === "completed";
    const detail =
      settlement.status === "completed"
        ? settlement.output
        : settlement.status === "failed"
          ? settlement.error
          : "reason" in settlement
            ? settlement.reason
            : undefined;
    await WorkItemStore.addEvidence(
      record.workItemId,
      {
        kind: "custom",
        description: `delegation ${settlement.status}: worker-reported, unverified`,
        passed: completed,
        ...(detail === undefined || detail.length === 0 ? {} : { detail }),
      },
      traceId,
    );
    await WorkItemAttemptRun.finish(
      record.origin.sessionId,
      record.delegationId,
      Delegation.settlementToAttemptOutcome(settlement.status),
      traceId,
      { endedAt: options.now() },
    );
  }

  return { openAssign, closeAttempt };
}
