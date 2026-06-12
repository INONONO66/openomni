import { Operational, type Storage as ProtocolStorage, WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage.js";
import { verifyCompletionReport } from "./completion-report.js";
import { retryWorkItem } from "./retry.js";
import { defaultMaxAttempts } from "./retry-policy.js";

type WorkItemAdapter = NonNullable<Storage.Adapter["workItem"]>;

type DependencyReadiness = {
  met: boolean;
  reason: "all_complete" | "pending" | "failed" | "blocked";
};

type CreateWorkItemInput = {
  name: string;
  sourceMessageId: string;
  sourceChannel: string;
  intent: string;
  goal: string;
  assigneeId?: string;
  sessionId?: string;
  context?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  parentHash?: string;
  dependsOn?: string[];
  originSessionId?: string;
  workSessionId?: string;
  workerRunId?: string;
  executorKind?: WorkItem.ExecutorKind;
  maxAttempts?: number;
};

export namespace WorkItemStore {
  export async function create(input: CreateWorkItemInput): Promise<WorkItem.Info> {
    const adapter = Storage.get();
    if (!adapter.workItem) {
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        sessionId: input.sessionId,
        component: "work-item",
        msg: "WorkItem storage not configured, skipping create",
      });
      return buildWorkItem(input, Date.now());
    }

    if (input.dependsOn && input.dependsOn.length > 0) {
      detectCycles(adapter.workItem, input.dependsOn, new Set());
    }

    const now = Date.now();
    const parent = input.parentHash ? adapter.workItem.get(input.parentHash) : undefined;
    if (input.parentHash && !parent) {
      throw new Error(`Parent work item not found: ${input.parentHash}`);
    }

    const item = buildWorkItem(input, now);
    adapter.workItem.set(item.hash, item);

    if (parent && !parent.relations.childHashes.includes(item.hash)) {
      adapter.workItem.set(parent.hash, {
        ...parent,
        relations: {
          ...parent.relations,
          childHashes: [...parent.relations.childHashes, item.hash],
        },
        timestamps: { ...parent.timestamps, updated: now },
      });
      Bus.publish(WorkItem.Events.Updated, {
        traceId: crypto.randomUUID(),
        time: now,
        sessionId: parent.sessionId,
        payload: { hash: parent.hash, fields: ["relations"] },
      });
    }

    Bus.publish(WorkItem.Events.Created, {
      traceId: crypto.randomUUID(),
      time: now,
      sessionId: item.sessionId,
      payload: {
        hash: item.hash,
        name: item.name,
        sessionId: item.sessionId,
        assigneeId: item.assigneeId,
      },
    });

    return item;
  }

  export function get(hash: string): WorkItem.Info | undefined {
    return Storage.get().workItem?.get(hash);
  }

  export function list(filter?: ProtocolStorage.WorkItemListFilter): WorkItem.Info[] {
    return Storage.get().workItem?.list(filter) ?? [];
  }

  export function remove(hash: string): boolean {
    const adapter = Storage.get();
    if (!adapter.workItem) return false;

    const existing = adapter.workItem.get(hash);
    if (!existing) return false;

    if (existing.relations.parentHash) {
      const parent = adapter.workItem.get(existing.relations.parentHash);
      if (parent) {
        const filtered = parent.relations.childHashes.filter((h) => h !== hash);
        if (filtered.length !== parent.relations.childHashes.length) {
          adapter.workItem.set(parent.hash, {
            ...parent,
            relations: { ...parent.relations, childHashes: filtered },
            timestamps: { ...parent.timestamps, updated: Date.now() },
          });
        }
      }
    }

    for (const item of adapter.workItem.list()) {
      if (item.relations.dependsOn.includes(hash)) {
        adapter.workItem.set(item.hash, {
          ...item,
          relations: {
            ...item.relations,
            dependsOn: item.relations.dependsOn.filter((h) => h !== hash),
          },
          timestamps: { ...item.timestamps, updated: Date.now() },
        });
      }
    }

    const removed = adapter.workItem.remove(hash);
    if (removed) {
      Bus.publish(WorkItem.Events.Removed, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        sessionId: existing.sessionId,
        payload: { hash, sessionId: existing.sessionId },
      });
    }
    return removed;
  }

  export async function update(
    hash: string,
    fields: Partial<Omit<WorkItem.Info, "hash">>,
  ): Promise<WorkItem.Info | undefined> {
    const adapter = Storage.get();
    if (!adapter.workItem) return undefined;

    const existing = adapter.workItem.get(hash);
    if (!existing) return undefined;

    const managedFields = [
      "timestamps",
      "failureReason",
      "attempt",
      "blockers",
      "evidence",
      "completionReport",
      "verificationGate",
    ] as const;
    for (const key of managedFields) {
      if (key in fields) {
        throw new Error(`Use lifecycle helpers instead of update() for "${key}"`);
      }
    }
    if (fields.relations) {
      const r = fields.relations as Record<string, unknown>;
      if (r.parentHash !== undefined) {
        throw new Error("Cannot change parentHash after creation — create a new work item instead");
      }
      if (fields.relations.dependsOn) {
        detectCycles(adapter.workItem, fields.relations.dependsOn, new Set([hash]));
      }
    }

    const now = Date.now();
    const updated: WorkItem.Info = {
      ...existing,
      ...fields,
      hash,
      timestamps: {
        ...existing.timestamps,
        ...(fields.timestamps ?? {}),
        updated: now,
      },
      relations: {
        ...existing.relations,
        ...(fields.relations ?? {}),
        parentHash: existing.relations.parentHash,
        childHashes: existing.relations.childHashes,
      },
    };

    return persistMutation(adapter.workItem, existing, updated, now, Object.keys(fields));
  }

  export async function start(hash: string): Promise<WorkItem.Info | undefined> {
    return mutateTimestamps(hash, "started", (timestamps, now) => ({
      ...timestamps,
      started: now,
      updated: now,
    }));
  }

  export async function complete(
    hash: string,
    completionReport: WorkItem.CompletionReport,
  ): Promise<WorkItem.Info | undefined> {
    return mutate(hash, (existing, now) => ({
      changedFields: ["timestamps", "completionReport"],
      target: "completed",
      updated: {
        ...existing,
        completionReport: verifyCompletionReport(existing, completionReport),
        timestamps: { ...existing.timestamps, completed: now, updated: now },
      },
      afterPublish: (updated) => {
        Bus.publish(WorkItem.Events.Completed, {
          traceId: crypto.randomUUID(),
          time: now,
          sessionId: updated.sessionId,
          payload: { hash, sessionId: updated.sessionId },
        });
      },
    }));
  }

  export async function fail(hash: string, reason?: string): Promise<WorkItem.Info | undefined> {
    return mutate(hash, (existing, now) => ({
      changedFields: ["timestamps", "failureReason"],
      target: "failed",
      updated: {
        ...existing,
        timestamps: { ...existing.timestamps, failed: now, updated: now },
        failureReason: reason,
      },
      afterPublish: (updated) => {
        Bus.publish(WorkItem.Events.Failed, {
          traceId: crypto.randomUUID(),
          time: now,
          sessionId: updated.sessionId,
          payload: { hash, reason, sessionId: updated.sessionId },
        });
      },
    }));
  }

  export async function cancel(hash: string): Promise<WorkItem.Info | undefined> {
    return mutateTimestamps(hash, "cancelled", (timestamps, now) => ({
      ...timestamps,
      cancelled: now,
      updated: now,
    }));
  }

  export async function addBlocker(
    hash: string,
    blocker: Omit<WorkItem.Blocker, "id" | "createdAt">,
  ): Promise<WorkItem.Info | undefined> {
    return mutate(hash, (existing, now) => ({
      changedFields: ["blockers"],
      updated: {
        ...existing,
        blockers: [...existing.blockers, { id: crypto.randomUUID(), ...blocker, createdAt: now }],
        timestamps: { ...existing.timestamps, updated: now },
      },
    }));
  }

  export async function resolveBlocker(
    hash: string,
    blockerId: string,
  ): Promise<WorkItem.Info | undefined> {
    return mutate(hash, (existing, now) => ({
      changedFields: ["blockers"],
      updated: {
        ...existing,
        blockers: existing.blockers.map((blocker) =>
          blocker.id === blockerId ? { ...blocker, resolvedAt: now } : blocker,
        ),
        timestamps: { ...existing.timestamps, updated: now },
      },
    }));
  }

  export async function addEvidence(
    hash: string,
    evidence: Omit<WorkItem.Evidence, "id" | "createdAt">,
  ): Promise<WorkItem.Info | undefined> {
    return mutate(hash, (existing, now) => ({
      changedFields: ["evidence"],
      updated: {
        ...existing,
        evidence: [
          ...existing.evidence,
          WorkItem.Evidence.parse({ id: crypto.randomUUID(), ...evidence, createdAt: now }),
        ],
        timestamps: { ...existing.timestamps, updated: now },
      },
    }));
  }

  export async function addReadBackEvidence(
    hash: string,
    check: WorkItem.ReadBackCheck,
  ): Promise<WorkItem.Info | undefined> {
    const readBack = WorkItem.ReadBackCheck.parse(check);
    return addEvidence(hash, {
      kind: "verification",
      description: `${readBack.kind} read-back ${readBack.passed ? "passed" : "failed"} for ${readBack.target}`,
      passed: readBack.passed,
      detail: JSON.stringify(readBack),
      readBack,
    });
  }

  export async function setVerificationGate(
    hash: string,
    gate: WorkItem.VerificationGate,
  ): Promise<WorkItem.Info | undefined> {
    return mutate(hash, (existing, now) => ({
      changedFields: ["verificationGate"],
      updated: {
        ...existing,
        verificationGate: gate,
        timestamps: { ...existing.timestamps, updated: now },
      },
    }));
  }

  export function areDependenciesMet(hash: string): DependencyReadiness {
    const workItem = Storage.get().workItem;
    if (!workItem) return { met: false, reason: "pending" };

    const item = workItem.get(hash);
    if (!item) return { met: false, reason: "pending" };
    if (item.relations.dependsOn.length === 0) {
      return { met: true, reason: "all_complete" };
    }

    for (const dependencyHash of item.relations.dependsOn) {
      const dependency = workItem.get(dependencyHash);
      if (!dependency) return { met: false, reason: "pending" };

      const status = WorkItem.deriveStatus(dependency);
      if (status === "failed") return { met: false, reason: "failed" };
      if (status === "blocked") return { met: false, reason: "blocked" };
      if (status !== "completed") return { met: false, reason: "pending" };
    }

    return { met: true, reason: "all_complete" };
  }

  export async function retry(hash: string): Promise<WorkItem.Info | undefined> {
    return retryWorkItem(hash, Storage.get().workItem, persistMutation);
  }

  function buildWorkItem(input: CreateWorkItemInput, now: number): WorkItem.Info {
    const maxAttempts = input.maxAttempts ?? defaultMaxAttempts(input.executorKind);
    return WorkItem.Info.parse({
      hash: WorkItem.generateHash(),
      name: input.name,
      sourceMessageId: input.sourceMessageId,
      sourceChannel: input.sourceChannel,
      assigneeId: input.assigneeId,
      sessionId: input.sessionId,
      originSessionId: input.originSessionId,
      workSessionId: input.workSessionId,
      workerRunId: input.workerRunId,
      executorKind: input.executorKind,
      maxAttempts,
      attempt: 1,
      timestamps: { created: now, updated: now },
      relations: {
        parentHash: input.parentHash,
        childHashes: [],
        dependsOn: input.dependsOn ?? [],
      },
      intent: input.intent,
      goal: input.goal,
      context: input.context,
      constraints: input.constraints ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      changedFiles: [],
      blockers: [],
      evidence: [],
    });
  }

  function mutateTimestamps(
    hash: string,
    target: "started" | "cancelled",
    updateTimestamps: (
      timestamps: WorkItem.Info["timestamps"],
      now: number,
    ) => WorkItem.Info["timestamps"],
  ): Promise<WorkItem.Info | undefined> {
    return mutate(hash, (existing, now) => ({
      changedFields: ["timestamps"],
      updated: { ...existing, timestamps: updateTimestamps(existing.timestamps, now) },
      target,
    }));
  }

  async function mutate(
    hash: string,
    build: (
      existing: WorkItem.Info,
      now: number,
    ) => {
      updated: WorkItem.Info;
      changedFields: string[];
      target?: "started" | "completed" | "failed" | "cancelled";
      afterPublish?: (updated: WorkItem.Info) => void;
    },
  ): Promise<WorkItem.Info | undefined> {
    const adapter = Storage.get().workItem;
    if (!adapter) return undefined;

    const existing = adapter.get(hash);
    if (!existing) return undefined;

    const now = Date.now();
    const { updated, changedFields, target, afterPublish } = build(existing, now);
    if (target) assertTransition(existing, target);
    return persistMutation(adapter, existing, updated, now, changedFields, afterPublish);
  }

  function persistMutation(
    adapter: WorkItemAdapter,
    existing: WorkItem.Info,
    updated: WorkItem.Info,
    time: number,
    changedFields: string[],
    afterPublish?: (updated: WorkItem.Info) => void,
  ): WorkItem.Info {
    adapter.set(updated.hash, updated);

    const previousStatus = WorkItem.deriveStatus(existing);
    const nextStatus = WorkItem.deriveStatus(updated);
    if (previousStatus !== nextStatus) {
      Bus.publish(WorkItem.Events.StatusChanged, {
        traceId: crypto.randomUUID(),
        time,
        sessionId: updated.sessionId,
        payload: { hash: updated.hash, from: previousStatus, to: nextStatus },
      });
    }
    afterPublish?.(updated);
    Bus.publish(WorkItem.Events.Updated, {
      traceId: crypto.randomUUID(),
      time,
      sessionId: updated.sessionId,
      payload: { hash: updated.hash, fields: changedFields },
    });
    return updated;
  }

  function assertTransition(
    existing: WorkItem.Info,
    target: "started" | "completed" | "failed" | "cancelled",
  ): void {
    const status = WorkItem.deriveStatus(existing);
    if (
      target === "started" &&
      (status === "completed" || status === "cancelled" || status === "failed")
    ) {
      throw new Error(`Cannot start a ${status} work item — use retry() for failed items`);
    }
    if (target === "completed" && status === "failed") {
      throw new Error("Cannot complete a failed work item — retry() first");
    }
    if (target === "completed" && status === "cancelled") {
      throw new Error("Cannot complete a cancelled work item");
    }
    if (target === "failed" && status === "completed") {
      throw new Error("Cannot fail a completed work item");
    }
    if (target === "failed" && status === "cancelled") {
      throw new Error("Cannot fail a cancelled work item");
    }
    if (target === "cancelled" && status === "completed") {
      throw new Error("Cannot cancel a completed work item");
    }
  }

  function detectCycles(
    adapter: WorkItemAdapter,
    startHashes: string[],
    visited: Set<string>,
  ): void {
    for (const dependencyHash of startHashes) {
      if (visited.has(dependencyHash)) {
        throw new Error(
          `Circular dependency detected: ${dependencyHash} is already in the dependency chain`,
        );
      }

      const dependency = adapter.get(dependencyHash);
      if (dependency && dependency.relations.dependsOn.length > 0) {
        detectCycles(
          adapter,
          dependency.relations.dependsOn,
          new Set([...visited, dependencyHash]),
        );
      }
    }
  }
}
