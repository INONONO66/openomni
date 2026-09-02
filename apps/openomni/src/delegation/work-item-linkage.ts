import { newTraceId } from "@openomni/telemetry";
import { WorkItemAttemptRun, WorkItemStore } from "@openomni/ledger";
import { Delegation, WorkItem } from "@openomni/protocol";

/**
 * The bridge between the delegation kernel and the WorkItem contract: every
 * admitted assign commissions a WorkItem with an allocated attempt, and every
 * settlement closes that attempt — demoting the worker's report to Evidence,
 * never to completion. Completion stays admission-only (docs/kernel-contract.md).
 */
export interface WorkItemLinkage {
  /** Commission the WorkItem and its attempt at admission. Returns the WorkItem id. */
  openAssign(input: OpenAssignInput): Promise<string>;
  /** Roll back a commissioned assign whose final admission write was refused. */
  cancelAssign(workItemId: string): Promise<void>;
  /** Close the attempt from the settlement fold. Unknown items are a no-op. */
  closeAttempt(input: CloseAttemptInput): Promise<void>;
  /**
   * Restart sweep: re-close attempts whose settlement committed but whose
   * ledger write was lost (closeAttempt is idempotent, so re-runs are safe).
   */
  recoverAttempts(lookup: (delegationId: string) => Delegation.Record | undefined): Promise<void>;
}

interface OpenAssignInput {
  readonly delegationId: string;
  /** The worker run identity allocated before the WorkItem assignment. */
  readonly workerRunId?: string;
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
    try {
      await commission(item.workItemId, input, traceId);
    } catch (error) {
      // Never leave an orphan pending item behind a refused admission.
      await cancelAssign(item.workItemId, traceId);
      throw error;
    }
    return item.workItemId;
  }

  async function cancelAssign(workItemId: string, traceId = newTraceId()): Promise<void> {
    await WorkItemStore.cancel(workItemId, traceId);
  }

  async function commission(
    workItemId: string,
    input: OpenAssignInput,
    traceId: string,
  ): Promise<void> {
    await WorkItemStore.assignExecution(
      workItemId,
      {
        executorKind: executorKindOf(input.transport),
        workerRunId: input.workerRunId ?? input.delegationId,
        workSessionId: input.sessionId,
      },
      traceId,
    );
    const allocated = await WorkItemStore.allocateAttempt(
      workItemId,
      {
        contentFingerprint: WorkItem.contentFingerprintOf({
          workInput: input.instruction,
          handlerKind: `delegation:${input.transport}`,
          handlerCodeRef: {
            absent: true,
            reason: "handler code identity not captured at delegation admission",
          },
          model: {
            provider: options.model.provider,
            id: options.model.id,
            parameters: { absent: true, reason: "provider defaults; no per-delegation overrides" },
          },
          upstreamFingerprints: {
            absent: true,
            reason: "a delegation attempt consumes no upstream attempts",
          },
          dependencyLock: {
            absent: true,
            reason: "dependency lock not captured at delegation admission",
          },
        }),
        environmentFingerprint: WorkItem.environmentFingerprintOf({
          os: process.platform,
          arch: process.arch,
          bunVersion: Bun.version,
          workspaceRoot: { absent: true, reason: "delegated work runs outside a fixed workspace" },
          schemaVersions: { delegation: 1, workItem: 1 },
          policy: { absent: true, reason: "no policy plan is bound at delegation admission" },
          toolVersions: { absent: true, reason: "worker tool catalog is resolved after admission" },
          verifierVersions: {
            absent: true,
            reason: "verification happens at completion admission, not here",
          },
          providerParameters: {
            absent: true,
            reason: "provider defaults; no per-delegation overrides",
          },
          configRef: {
            absent: true,
            reason: "config identity not captured at delegation admission",
          },
        }),
      },
      traceId,
    );
    if (allocated === undefined) {
      throw new Error(`WorkItem ${workItemId} refused an attempt at admission`);
    }
  }

  async function closeAttempt(input: CloseAttemptInput): Promise<void> {
    const { record, settlement } = input;
    if (record.workItemId === undefined || settlement.status === "sent") return;
    // Spend rides the durable settlement itself, so a restart-sweep re-close
    // recovers the same tokens the live fold would have recorded.
    // #807: an assign now settles verified|unverified, and both carry the same
    // reported output/usage the `completed` arm carries for an ask.
    const reported =
      settlement.status === "completed" ||
      settlement.status === "verified" ||
      settlement.status === "unverified"
        ? settlement
        : undefined;
    const tokens = reported?.usage?.tokens;
    const item = await WorkItemStore.get(record.workItemId);
    // Unknown item: a legacy record upcast points at nothing durable — no-op.
    if (item === undefined || item.attemptTerminal !== undefined) return;
    const traceId = newTraceId();
    const detail =
      reported !== undefined
        ? reported.output
        : settlement.status === "failed"
          ? settlement.error
          : "reason" in settlement
            ? settlement.reason
            : undefined;
    // The worker's report never passes verification by itself: `passed`
    // stays false so terminal linkage can only ride Resident-verified
    // evidence. The explicit id makes a re-run of this close a no-op write.
    await WorkItemStore.addEvidence(
      record.workItemId,
      {
        id: `evidence:delegation:${record.delegationId}:settlement`,
        kind: "custom",
        description: `delegation ${settlement.status}: worker-reported, unverified`,
        passed: false,
        ...(detail === undefined || detail.length === 0 ? {} : { detail }),
      },
      traceId,
    );
    // Locate the attempt using its commissioned pair. The settlement carries
    // the final driven run ID and stores it on the terminal attempt fact.
    const assignedRunId = item.workerRunId ?? record.delegationId;
    const workSessionId = item.workSessionId ?? record.origin.sessionId;
    await WorkItemAttemptRun.finish(
      workSessionId,
      assignedRunId,
      Delegation.settlementToAttemptOutcome(settlement.status),
      traceId,
      {
        endedAt: options.now(),
        ...(settlement.workerRunId === undefined ? {} : { workerRunId: settlement.workerRunId }),
        usage: WorkItem.AttemptUsage.parse({
          seconds: Math.max(0, (settlement.at - record.createdAt) / 1000),
          ...(tokens === undefined ? {} : { tokens }),
        }),
      },
    );
  }

  async function recoverAttempts(
    lookup: (delegationId: string) => Delegation.Record | undefined,
  ): Promise<void> {
    for (const item of WorkItemStore.list()) {
      if (
        item.sourceChannel !== "delegation" ||
        item.attemptTerminal !== undefined ||
        item.timestamps.cancelled !== undefined
      ) {
        continue;
      }
      const record = lookup(item.sourceMessageId);
      if (record === undefined) {
        await cancelAssign(item.workItemId);
        continue;
      }
      if (record.status === "settled" && record.settled !== undefined) {
        await closeAttempt({ record, settlement: record.settled });
      }
    }
  }

  return { openAssign, cancelAssign, closeAttempt, recoverAttempts };
}
