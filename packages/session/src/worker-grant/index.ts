import { Communication } from "@openomni/protocol";
import { Bus } from "../bus";
import { Storage } from "../storage/storage";

const riskRank = { low: 1, medium: 2, high: 3 } as const;

function requireAdapter() {
  const adapter = Storage.get().workerGrant;
  if (!adapter) throw new Error("Storage adapter does not implement workerGrant");
  return adapter;
}

function eventBase(record: Communication.WorkerGrant.Record) {
  return {
    id: record.id,
    workerRunId: record.workerRunId,
    status: record.status,
    version: record.version,
    time: Date.now(),
  };
}

function createRecord(input: Communication.WorkerGrant.Create): Communication.WorkerGrant.Record {
  const now = Date.now();
  return Communication.WorkerGrant.Record.parse({
    ...input,
    status: input.status ?? "active",
    version: input.version ?? 1,
    canCreateExternalTasks: input.canCreateExternalTasks ?? false,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
  });
}

function matchesList(list: readonly string[] | undefined, value: string | undefined): boolean {
  if (list === undefined) return true;
  if (list.length === 0) return false;
  return value !== undefined && list.includes(value);
}

function isActive(record: Communication.WorkerGrant.Record, now = Date.now()): boolean {
  return record.status === "active" && (record.expiresAt === undefined || record.expiresAt > now);
}

function isPastExpiry(record: Communication.WorkerGrant.Record, now = Date.now()): boolean {
  return record.status === "active" && record.expiresAt !== undefined && record.expiresAt <= now;
}

function evaluateRecord(
  record: Communication.WorkerGrant.Record,
  input: Communication.WorkerGrant.Evaluation,
): Communication.WorkerGrant.EvaluationResult {
  if (!isActive(record)) return { allowed: false, reason: "worker_grant.inactive" };
  if (!record.allowedActions.includes(input.action)) {
    return { allowed: false, reason: "worker_grant.action.denied" };
  }
  if (!matchesList(record.allowedSessionIds, input.sessionId)) {
    return { allowed: false, reason: "worker_grant.session.denied" };
  }
  if (!matchesList(record.allowedActorIds, input.actorId)) {
    return { allowed: false, reason: "worker_grant.actor.denied" };
  }
  if (!matchesList(record.allowedEndpointIds, input.endpointId)) {
    return { allowed: false, reason: "worker_grant.endpoint.denied" };
  }
  if (input.createsExternalTask && !record.canCreateExternalTasks) {
    return { allowed: false, reason: "worker_grant.external_create.denied" };
  }
  if (
    record.managerGrant?.allowedActorGroups !== undefined &&
    !matchesList(record.managerGrant.allowedActorGroups, input.actorGroup)
  ) {
    return { allowed: false, reason: "worker_grant.actor_group.denied" };
  }
  if (record.managerGrant?.riskCeiling !== undefined) {
    const inputRank = input.risk ? riskRank[input.risk] : undefined;
    const ceilingRank = riskRank[record.managerGrant.riskCeiling];
    if (inputRank === undefined || inputRank > ceilingRank) {
      return { allowed: false, reason: "worker_grant.risk.denied" };
    }
  }
  return { allowed: true, reason: "worker_grant.allowed", grantId: record.id };
}

export namespace WorkerGrantStore {
  export type Record = Communication.WorkerGrant.Record;
  export type Create = Communication.WorkerGrant.Create;
  export type Evaluation = Communication.WorkerGrant.Evaluation;
  export type EvaluationResult = Communication.WorkerGrant.EvaluationResult;

  export function create(input: Create): Record {
    const adapter = requireAdapter();
    const record = createRecord(input);
    if (adapter.get(record.id)) throw new Error(`WorkerGrant already exists: ${record.id}`);
    adapter.create(record);
    Bus.publish(Communication.WorkerGrant.Events.Created, eventBase(record));
    return record;
  }

  export function get(id: string): Record | undefined {
    return requireAdapter().get(id);
  }

  export function list(workerRunId?: string): Record[] {
    return requireAdapter().list(workerRunId);
  }

  function persistUpdate(
    id: string,
    patch: Partial<Omit<Record, "id" | "workerRunId">>,
    event: "updated" | "revoked" | "expired",
  ): Record {
    const adapter = requireAdapter();
    const current = adapter.get(id);
    if (!current) throw new Error(`WorkerGrant not found: ${id}`);
    const updated = Communication.WorkerGrant.Record.parse({
      ...current,
      ...patch,
      version: current.version + 1,
      updatedAt: Date.now(),
    });
    adapter.set(updated);
    const descriptor =
      event === "updated"
        ? Communication.WorkerGrant.Events.Updated
        : event === "revoked"
          ? Communication.WorkerGrant.Events.Revoked
          : Communication.WorkerGrant.Events.Expired;
    Bus.publish(descriptor, eventBase(updated));
    return updated;
  }

  export function update(id: string, patch: Partial<Omit<Record, "id" | "workerRunId">>): Record {
    return persistUpdate(id, patch, "updated");
  }

  export function revoke(id: string): Record {
    return persistUpdate(id, { status: "revoked", revokedAt: Date.now() }, "revoked");
  }

  export function expire(id: string): Record {
    return persistUpdate(id, { status: "expired" }, "expired");
  }

  export function cleanupExpired(workerRunId?: string): Record[] {
    return requireAdapter()
      .list(workerRunId)
      .filter((grant) => isPastExpiry(grant))
      .map((grant) => expire(grant.id));
  }

  export function evaluate(input: Evaluation): EvaluationResult {
    const parsedInput = Communication.WorkerGrant.Evaluation.safeParse(input);
    if (!parsedInput.success) {
      return { allowed: false, reason: "worker_grant.evaluation.invalid" };
    }
    const parsed = parsedInput.data;
    const grants = requireAdapter().list(parsed.workerRunId);
    let firstDenial: EvaluationResult | undefined;
    for (const grant of grants) {
      const result = evaluateRecord(grant, parsed);
      Bus.publish(Communication.WorkerGrant.Events.Evaluated, {
        ...eventBase(grant),
        allowed: result.allowed,
        reason: result.reason,
        action: parsed.action,
      });
      if (result.allowed) return result;
      firstDenial ??= result;
    }
    return firstDenial ?? { allowed: false, reason: "worker_grant.no_matching_grant" };
  }

  export function remove(id: string): boolean {
    return requireAdapter().remove(id);
  }
}
