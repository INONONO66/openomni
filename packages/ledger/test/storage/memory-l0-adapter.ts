import {
  Alarm,
  canonicalDigest,
  Deadline,
  Inbox,
  LedgerAction,
  LedgerSession,
  PolicyRow,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { alarmAppend, inboxAppend } from "../../src/storage/l0-action-builders.js";

export interface MemoryL0Adapter {
  transaction<T>(operation: () => T): T;
  sessions: ProtocolStorage.SessionLedgerSubAdapter;
  actions: ProtocolStorage.ActionSubAdapter;
  inbox: ProtocolStorage.InboxSubAdapter;
  alarms: ProtocolStorage.AlarmSubAdapter;
  policies: ProtocolStorage.PolicyRowSubAdapter;
}

export function createMemoryL0Adapter(): MemoryL0Adapter {
  const sessionRows = new Map<string, LedgerSession.Row>();
  const actionRows = new Map<string, LedgerAction.Node>();
  const inboxRows = new Map<string, Inbox.Row>();
  const alarmRows = new Map<string, Alarm.Row>();
  const policyRows = new Map<string, PolicyRow.Row>();

  const transaction = <T>(operation: () => T): T => {
    const before = {
      sessions: new Map(sessionRows),
      actions: new Map(actionRows),
      inbox: new Map(inboxRows),
      alarms: new Map(alarmRows),
      policies: new Map(policyRows),
    };
    try {
      return operation();
    } catch (error) {
      restore(sessionRows, before.sessions);
      restore(actionRows, before.actions);
      restore(inboxRows, before.inbox);
      restore(alarmRows, before.alarms);
      restore(policyRows, before.policies);
      throw error;
    }
  };

  const sessions: ProtocolStorage.SessionLedgerSubAdapter = {
    create(row) {
      const parsed = LedgerSession.Row.parse(row);
      if (sessionRows.has(parsed.id)) return false;
      sessionRows.set(parsed.id, parsed);
      return true;
    },
    materialize(input) {
      const parsed = LedgerSession.Materialize.parse(input);
      if (
        parsed.initialAction.sessionId !== parsed.row.id ||
        parsed.initialAction.kind !== "session.configure" ||
        parsed.initialAction.parentId !== null ||
        parsed.row.revision !== 0
      ) {
        return undefined;
      }
      return transaction(() => {
        const existing = sessionRows.get(parsed.row.id);
        if (existing !== undefined) return { created: false, row: existing };
        sessionRows.set(parsed.row.id, parsed.row);
        const receipt = appendMemoryAction(sessionRows, actionRows, parsed.initialAction, 0);
        if (receipt === undefined) throw new Error("initial session configuration was refused");
        const row = sessionRows.get(parsed.row.id);
        if (row === undefined) throw new Error("materialized session disappeared");
        return { created: true, row, receipt };
      });
    },
    get: (id) => sessionRows.get(id),
    list: () => [...sessionRows.values()].sort((left, right) => left.id.localeCompare(right.id)),
    acquireLease(input) {
      const request = LedgerSession.AcquireLease.parse(input);
      return transaction(() => {
        const current = sessionRows.get(request.sessionId);
        if (current === undefined) return undefined;
        if (current.leaseFence !== request.expectedFence) {
          return { ok: false, reason: "stale", currentFence: current.leaseFence };
        }
        if (
          current.leaseOwner !== null &&
          current.leaseOwner !== request.owner &&
          current.leaseExpiresAt !== null &&
          !Deadline.isExpired(request.now, current.leaseExpiresAt)
        ) {
          return {
            ok: false,
            reason: "held",
            holder: current.leaseOwner,
            expiresAt: current.leaseExpiresAt,
          };
        }
        const fence = current.leaseFence + 1;
        sessionRows.set(current.id, {
          ...current,
          leaseOwner: request.owner,
          leaseFence: fence,
          leaseExpiresAt: request.expiresAt,
        });
        return { ok: true, fence };
      });
    },
    renewLease(input) {
      const request = LedgerSession.RenewLease.parse(input);
      return transaction(() => {
        const current = sessionRows.get(request.sessionId);
        if (
          current === undefined ||
          current.leaseOwner !== request.owner ||
          current.leaseFence !== request.fence ||
          current.leaseExpiresAt === null ||
          Deadline.isExpired(request.now, current.leaseExpiresAt)
        ) {
          return false;
        }
        sessionRows.set(current.id, { ...current, leaseExpiresAt: request.expiresAt });
        return true;
      });
    },
    commit(input) {
      const request = LedgerSession.Commit.parse(input);
      return transaction(() => commitMemorySession(sessionRows, actionRows, inboxRows, request));
    },
  };

  function control(id: string, at: number, op: "cancel" | "rearm") {
    return transaction(() => {
      const current = alarmRows.get(id);
      if (current === undefined || current.status === "cancelled") return undefined;
      const session = sessionRows.get(current.sessionId);
      if (session === undefined) return undefined;
      const row: Alarm.Row = {
        ...current,
        status: op === "cancel" ? "cancelled" : "armed",
        updatedAt: at,
        fence: current.fence + 1,
        ...(op === "rearm"
          ? { epoch: current.epoch + 1, fireAt: at, notifications: 0, lastBatch: null }
          : {}),
      };
      const receipt = appendMemoryAction(
        sessionRows,
        actionRows,
        {
          id: canonicalDigest([id, row.epoch, op]),
          parentId: id,
          sessionId: row.sessionId,
          kind: "alarm.arm",
          intent: { encodingVersion: 1, value: { op, alarmId: id, epoch: row.epoch } },
          effect: {
            encodingVersion: 1,
            value: {
              status: row.status,
              epoch: row.epoch,
              fence: row.fence,
              fireAt: row.fireAt,
              notifications: row.notifications,
              lastBatch: row.lastBatch,
            },
          },
          irreversible: true,
          ts: at,
        },
        session.revision,
      );
      if (receipt === undefined) return undefined;
      alarmRows.set(id, row);
      return row;
    });
  }

  return {
    transaction,
    sessions,
    actions: {
      append(input, expectedRevision) {
        return transaction(() =>
          appendMemoryAction(
            sessionRows,
            actionRows,
            LedgerAction.Append.parse(input),
            expectedRevision,
          ),
        );
      },
      tree: (sessionId) =>
        [...actionRows.values()]
          .filter((action) => action.sessionId === sessionId)
          .sort((left, right) => left.ordinal - right.ordinal),
    },
    inbox: {
      commit(input) {
        const parsed = Inbox.Commit.parse(input);
        return transaction(() => {
          const session = sessionRows.get(parsed.sessionId);
          if (session === undefined || inboxRows.has(parsed.id) || actionRows.has(parsed.id)) {
            return undefined;
          }
          const receipt = appendMemoryAction(
            sessionRows,
            actionRows,
            inboxAppend(parsed),
            session.revision,
          );
          if (receipt === undefined) return undefined;
          const committed = Inbox.Row.parse({
            id: parsed.id,
            sessionId: parsed.sessionId,
            kind: parsed.kind,
            content: parsed.content,
            origin: parsed.origin,
            status: "pending",
            consumedBy: null,
            consumedAt: null,
            createdAt: parsed.createdAt,
            ordinal: nextInboxOrdinal(inboxRows, parsed.sessionId),
          });
          inboxRows.set(committed.id, committed);
          return committed;
        });
      },
      list(sessionId, status) {
        return [...inboxRows.values()]
          .filter(
            (row) => row.sessionId === sessionId && (status === undefined || row.status === status),
          )
          .sort(compareInboxRows);
      },
    },
    alarms: {
      arm(input) {
        const parsed = Alarm.Arm.parse(input);
        return transaction(() => {
          const session = sessionRows.get(parsed.sessionId);
          if (session === undefined || alarmRows.has(parsed.id) || actionRows.has(parsed.id)) {
            return undefined;
          }
          const receipt = appendMemoryAction(
            sessionRows,
            actionRows,
            alarmAppend(parsed),
            session.revision,
          );
          if (receipt === undefined) return undefined;
          const row = Alarm.Row.parse({
            ...parsed,
            status: "armed",
            createdAt: parsed.fireAt,
            updatedAt: parsed.fireAt,
          });
          alarmRows.set(row.id, row);
          return row;
        });
      },
      get: (id) => alarmRows.get(id),
      cancel: (id, at) => control(id, at, "cancel"),
      rearm: (id, at) => control(id, at, "rearm"),
      acquire(id, fence) {
        const row = alarmRows.get(id);
        if (row === undefined || row.status !== "armed" || row.fence !== fence) return undefined;
        const next = { ...row, fence: fence + 1 };
        alarmRows.set(id, next);
        return next;
      },
      fire(input) {
        return transaction(() => {
          const row = alarmRows.get(input.id);
          if (
            row === undefined ||
            row.status !== "armed" ||
            row.epoch !== input.epoch ||
            row.fence !== input.fence ||
            input.at < row.fireAt
          )
            return undefined;
          if (input.batchHash !== undefined && row.lastBatch === input.batchHash) return undefined;
          const session = sessionRows.get(row.sessionId);
          if (session === undefined) return undefined;
          const paused = !input.terminal && row.notifications >= input.limit;
          const status = paused
            ? "paused"
            : input.terminal || row.kind === "at"
              ? "fired"
              : "armed";
          const content = paused
            ? JSON.stringify({
                alarmId: row.id,
                epoch: row.epoch,
                reason: "wake_budget",
                status: "paused",
              })
            : input.content;
          const fired = appendMemoryAction(
            sessionRows,
            actionRows,
            {
              id: input.actionId,
              parentId: row.id,
              sessionId: row.sessionId,
              kind: paused ? "alarm.paused" : "alarm.fired",
              intent: {
                encodingVersion: 1,
                value: {
                  alarmId: row.id,
                  epoch: row.epoch,
                  fence: row.fence,
                  inboxId: input.inboxId,
                },
              },
              effect: { encodingVersion: 1, value: { status, content } },
              irreversible: true,
              ts: input.at,
            },
            session.revision,
          );
          if (fired === undefined) return undefined;
          const pending: Inbox.Commit = {
            id: input.inboxId,
            sessionId: row.sessionId,
            kind: "prompt",
            content,
            origin: { encodingVersion: 1, value: row.id },
            createdAt: input.at,
            parentActionId: input.actionId,
          };
          const prompt = appendMemoryAction(
            sessionRows,
            actionRows,
            inboxAppend(pending),
            fired.revision,
          );
          if (prompt === undefined) throw new Error("alarm prompt append refused");
          const inbox = Inbox.Row.parse({
            id: pending.id,
            sessionId: pending.sessionId,
            kind: pending.kind,
            content,
            origin: pending.origin,
            createdAt: pending.createdAt,
            status: "pending",
            consumedBy: null,
            consumedAt: null,
            ordinal: nextInboxOrdinal(inboxRows, row.sessionId),
          });
          inboxRows.set(inbox.id, inbox);
          const next: Alarm.Row = {
            ...row,
            status,
            notifications: row.notifications + (paused || input.terminal ? 0 : 1),
            lastBatch: input.batchHash ?? row.lastBatch,
            fence: row.fence + (status === "armed" ? 0 : 1),
            updatedAt: input.at,
          };
          alarmRows.set(row.id, next);
          return { row: next, inbox, receipts: [fired, prompt] };
        });
      },
      due(at) {
        return [...alarmRows.values()]
          .filter((row) => row.status === "armed" && row.fireAt <= at)
          .sort((left, right) => left.fireAt - right.fireAt || left.id.localeCompare(right.id));
      },
    },
    policies: {
      append(row) {
        const parsed = PolicyRow.Row.parse(row);
        const key = policyKey(parsed);
        if (policyRows.has(key)) return false;
        policyRows.set(key, parsed);
        return true;
      },
      rows(generation) {
        return [...policyRows.values()]
          .filter((row) => generation === undefined || row.generation === generation)
          .sort(comparePolicyRows);
      },
    },
  };
}

function restore<K, V>(target: Map<K, V>, snapshot: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

function appendMemoryAction(
  sessions: Map<string, LedgerSession.Row>,
  actions: Map<string, LedgerAction.Node>,
  input: LedgerAction.Append,
  expectedRevision: number,
): LedgerAction.Receipt | undefined {
  const session = sessions.get(input.sessionId);
  if (session === undefined || session.revision !== expectedRevision) return undefined;
  if (actions.has(input.id) || !hasValidParent(actions, input)) return undefined;
  const action = LedgerAction.Node.parse({ ...input, ordinal: expectedRevision + 1 });
  actions.set(action.id, action);
  sessions.set(session.id, { ...session, revision: expectedRevision + 1 });
  return { action, revision: expectedRevision + 1 };
}

function commitMemorySession(
  sessions: Map<string, LedgerSession.Row>,
  actions: Map<string, LedgerAction.Node>,
  inbox: Map<string, Inbox.Row>,
  request: LedgerSession.Commit,
): LedgerSession.CommitResult | undefined {
  const current = sessions.get(request.sessionId);
  if (current === undefined) return undefined;
  if (
    current.leaseOwner !== request.owner ||
    current.leaseFence !== request.fence ||
    current.leaseExpiresAt === null ||
    Deadline.isExpired(request.now, current.leaseExpiresAt)
  ) {
    return memoryRefusal("stale", current);
  }
  if (current.revision !== request.expectedRevision) return memoryRefusal("revision", current);
  if (!validInboxConsumption(inbox, request)) return memoryRefusal("inbox", current);
  if (!validActionBatch(actions, request.actions, request.sessionId)) {
    return memoryRefusal("revision", current);
  }

  const receipts: LedgerAction.Receipt[] = [];
  let revision = current.revision;
  for (const action of request.actions) {
    const receipt = appendMemoryAction(sessions, actions, action, revision);
    if (receipt === undefined) throw new Error("validated session action was refused");
    receipts.push(receipt);
    revision = receipt.revision;
  }
  for (const id of request.consumeInboxIds) {
    const row = inbox.get(id);
    if (row === undefined) throw new Error("validated inbox row disappeared");
    inbox.set(id, {
      ...row,
      status: "consumed",
      consumedBy: request.owner,
      consumedAt: request.now,
    });
  }
  const row = sessions.get(request.sessionId);
  if (row === undefined) throw new Error("committed session disappeared");
  const generation = request.generation ?? row;
  const committed = LedgerSession.Row.parse({
    ...row,
    state: request.state,
    toolsGeneration: generation.toolsGeneration,
    systemHash: generation.systemHash,
    policyGeneration: generation.policyGeneration,
    leaseOwner: request.releaseLease ? null : request.owner,
    leaseExpiresAt: request.releaseLease ? null : row.leaseExpiresAt,
  });
  sessions.set(committed.id, committed);
  return { ok: true, row: committed, receipts };
}

function memoryRefusal(
  reason: "stale" | "revision" | "inbox",
  current: LedgerSession.Row,
): LedgerSession.CommitResult {
  return {
    ok: false,
    reason,
    currentFence: current.leaseFence,
    currentRevision: current.revision,
  };
}

function validInboxConsumption(
  rows: ReadonlyMap<string, Inbox.Row>,
  request: LedgerSession.Commit,
): boolean {
  if (new Set(request.consumeInboxIds).size !== request.consumeInboxIds.length) return false;
  return request.consumeInboxIds.every((id) => {
    const row = rows.get(id);
    return row?.sessionId === request.sessionId && row.status === "pending";
  });
}

function validActionBatch(
  existing: ReadonlyMap<string, LedgerAction.Node>,
  batch: readonly LedgerAction.Append[],
  sessionId: string,
): boolean {
  const known = new Map(existing);
  let ordinal = Number.MAX_SAFE_INTEGER - batch.length;
  for (const action of batch) {
    if (action.sessionId !== sessionId || known.has(action.id)) return false;
    if (action.parentId !== null && known.get(action.parentId)?.sessionId !== sessionId)
      return false;
    ordinal += 1;
    known.set(action.id, LedgerAction.Node.parse({ ...action, ordinal }));
  }
  return true;
}

function hasValidParent(
  actions: ReadonlyMap<string, LedgerAction.Node>,
  input: LedgerAction.Append,
): boolean {
  if (input.parentId === null) return true;
  return actions.get(input.parentId)?.sessionId === input.sessionId;
}

function nextInboxOrdinal(rows: ReadonlyMap<string, Inbox.Row>, sessionId: string): number {
  let ordinal = 0;
  for (const row of rows.values()) {
    if (row.sessionId === sessionId) ordinal = Math.max(ordinal, row.ordinal);
  }
  return ordinal + 1;
}

function compareInboxRows(left: Inbox.Row, right: Inbox.Row): number {
  return left.ordinal - right.ordinal;
}

function policyKey(row: PolicyRow.Row): string {
  return `${row.generation}\u0000${row.name}\u0000${row.kind}\u0000${row.phase}`;
}

function comparePolicyRows(left: PolicyRow.Row, right: PolicyRow.Row): number {
  return (
    left.generation - right.generation ||
    right.priority - left.priority ||
    left.name.localeCompare(right.name) ||
    left.kind.localeCompare(right.kind) ||
    left.phase.localeCompare(right.phase)
  );
}
