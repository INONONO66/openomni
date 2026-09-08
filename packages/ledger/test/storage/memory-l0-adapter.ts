import {
  Alarm,
  canonicalDigest,
  Deadline,
  Inbox,
  LedgerAction,
  LedgerSession,
  PolicyRow,
  SessionTransition,
  SessionTurn,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { alarmAppend, alarmOccurrence, inboxAppend } from "../../src/storage/l0-action-builders.js";

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

  function openChildCount(parentId: string): number {
    return [...sessionRows.values()].filter((child) => {
      if (child.parentId !== parentId) return false;
      if (
        [...inboxRows.values()].some(
          (item) => item.sessionId === child.id && item.status === "pending",
        )
      )
        return true;
      const actions = [...actionRows.values()].filter(
        (action) => action.sessionId === child.id && action.kind === "turn",
      );
      if (
        actions.some((action) => {
          const intent = SessionTurn.Intent.safeParse(action.intent.value);
          return intent.success && !actionRows.has(intent.data.resultId);
        })
      )
        return true;
      const terminal = actions
        .flatMap((action) => {
          const parsed = SessionTurn.Terminal.safeParse(action.effect.value);
          return parsed.success ? [parsed.data] : [];
        })
        .at(-1);
      return terminal === undefined || terminal.kind === "waiting";
    }).length;
  }

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
        const receipt = appendMemoryAction(
          sessionRows,
          actionRows,
          alarmRows,
          parsed.initialAction,
          0,
        );
        if (receipt === undefined) throw new Error("initial session configuration was refused");
        const row = sessionRows.get(parsed.row.id);
        if (row === undefined) throw new Error("materialized session disappeared");
        return { created: true, row, receipt };
      });
    },
    get: (id) => sessionRows.get(id),
    openChildCount,
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
      try {
        return transaction(() => {
          const current = sessionRows.get(request.sessionId);
          if (current === undefined) return undefined;
          const result = commitMemorySession(
            sessionRows,
            actionRows,
            inboxRows,
            alarmRows,
            request.admit === undefined ? request : { ...request, releaseLease: false },
          );
          if (result?.ok !== true) return result;
          const receipts = [...result.receipts];
          if (request.receive !== undefined) {
            const received = adapter.inbox.commit(request.receive);
            if (received === undefined) {
              throw new MemorySessionCommitRefused(memoryRefusal("inbox", current));
            }
            const action = actionRows.get(received.id);
            if (action === undefined) throw new Error("receiving inbox action is missing");
            receipts.push({ action, revision: action.ordinal });
          }
          if (request.admit !== undefined) {
            const received = adapter.inbox.commit(request.admit);
            if (received === undefined)
              throw new MemorySessionCommitRefused(memoryRefusal("inbox", current));
            for (const action of adapter.actions.tree(received.sessionId))
              receipts.push({ action, revision: action.ordinal });
          }
          const row = sessionRows.get(request.sessionId);
          if (row === undefined) throw new Error("committed session missing");
          const final = request.releaseLease
            ? { ...row, leaseOwner: null, leaseExpiresAt: null }
            : row;
          sessionRows.set(final.id, final);
          return { ok: true as const, row: final, receipts };
        });
      } catch (error) {
        if (error instanceof MemorySessionCommitRefused) return error.result;
        throw error;
      }
    },
  };

  function control(id: string, sessionId: string, at: number, op: "cancel" | "rearm") {
    return transaction(() => {
      const current = alarmRows.get(id);
      if (
        current === undefined ||
        current.sessionId !== sessionId ||
        current.kind !== "watch" ||
        (current.status !== "armed" && current.status !== "paused")
      )
        return undefined;
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
        alarmRows,
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

  const adapter: MemoryL0Adapter = {
    transaction,
    sessions,
    actions: {
      append(input, expectedRevision) {
        return transaction(() =>
          appendMemoryAction(
            sessionRows,
            actionRows,
            alarmRows,
            LedgerAction.Append.parse(input),
            expectedRevision,
          ),
        );
      },
      tree: (sessionId) =>
        [...actionRows.values()]
          .filter((action) => action.sessionId === sessionId)
          .sort((left, right) => left.ordinal - right.ordinal),
      range: (sessionId, afterRevision, limit) =>
        [...actionRows.values()]
          .filter((action) => action.sessionId === sessionId && action.ordinal > afterRevision)
          .sort((left, right) => left.ordinal - right.ordinal)
          .slice(0, limit),
    },
    inbox: {
      commit(input) {
        const parsed = Inbox.Commit.parse(input);
        return transaction(() => {
          if (actionRows.has(parsed.id)) return undefined;
          if (!validInboxSender(sessionRows, parsed)) return undefined;
          const child = parsed.createSession;
          if (child !== undefined) {
            if (!validInboxChild(sessionRows, actionRows, parsed, child)) return undefined;
            if (!withinChildLimits(sessionRows, openChildCount, child.row.parentId, parsed.limits))
              return undefined;
            sessionRows.set(child.row.id, child.row);
            if (
              appendMemoryAction(sessionRows, actionRows, alarmRows, child.initialAction, 0) ===
              undefined
            ) {
              throw new Error("child configuration refused");
            }
          }
          const session = sessionRows.get(parsed.sessionId);
          if (session === undefined || inboxRows.has(parsed.id) || actionRows.has(parsed.id)) {
            return undefined;
          }
          const receipt = appendMemoryAction(
            sessionRows,
            actionRows,
            alarmRows,
            inboxAppend(parsed),
            session.revision,
          );
          if (receipt === undefined) {
            if (child !== undefined) throw new Error("message inbox commit refused");
            return undefined;
          }
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
      receive(input) {
        const parsed = Inbox.Commit.parse(input);
        return transaction(() => {
          let row = inboxRows.get(parsed.id);
          if (row !== undefined) {
            const digest = (
              value: Pick<Inbox.Row, "id" | "sessionId" | "kind" | "content" | "origin">,
            ) =>
              canonicalDigest({
                id: value.id,
                sessionId: value.sessionId,
                kind: value.kind,
                content: value.content,
                origin: value.origin,
              });
            if (digest(row) !== digest(parsed)) {
              throw new Error("message identity reused with different payload");
            }
          } else row = adapter.inbox.commit(parsed);
          if (row === undefined) return undefined;
          const action = actionRows.get(row.id);
          if (action === undefined) throw new Error("receiving inbox action is missing");
          return { row, receipt: { action, revision: action.ordinal } };
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
            alarmRows,
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
      cancel: (id, sessionId, at) => control(id, sessionId, at, "cancel"),
      rearm: (id, sessionId, at) => control(id, sessionId, at, "rearm"),
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
          const occurrence = row === undefined ? undefined : alarmOccurrence(row, input);
          if (row === undefined || occurrence === undefined) return undefined;
          const session = sessionRows.get(row.sessionId);
          if (session === undefined) return undefined;
          const { status, content, terminal } = occurrence;
          const fired = appendMemoryAction(
            sessionRows,
            actionRows,
            alarmRows,
            {
              id: occurrence.actionId,
              parentId: row.id,
              sessionId: row.sessionId,
              kind: status === "paused" ? "alarm.paused" : "alarm.fired",
              intent: {
                encodingVersion: 1,
                value: {
                  alarmId: row.id,
                  epoch: row.epoch,
                  fence: row.fence,
                  sourceKey: input.sourceKey,
                  inboxId: occurrence.inboxId,
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
            id: occurrence.inboxId,
            sessionId: row.sessionId,
            kind: "prompt",
            content,
            origin: { encodingVersion: 1, value: row.id },
            createdAt: input.at,
            parentActionId: occurrence.actionId,
          };
          const prompt = appendMemoryAction(
            sessionRows,
            actionRows,
            alarmRows,
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
            notifications: row.notifications + (status === "armed" ? 1 : 0),
            lastBatch: terminal ? row.lastBatch : (input.batchHash ?? row.lastBatch),
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
      appendGeneration(derive) {
        return transaction(() => {
          const all = this.rows();
          const latest = Math.max(0, ...all.map((row) => row.generation));
          const drafts = derive(all.filter((row) => row.generation === latest));
          if (drafts === undefined) return latest;
          if (drafts.length === 0) throw new Error("policy generation must not be empty");
          const generation = latest + 1;
          for (const draft of drafts) {
            if (!this.append({ ...draft, generation })) {
              throw new Error(`could not append policy row: ${draft.name}`);
            }
          }
          return generation;
        });
      },
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
  return adapter;
}

function validInboxSender(
  sessions: ReadonlyMap<string, LedgerSession.Row>,
  row: Inbox.Commit,
): boolean {
  if (row.sender === undefined) return true;
  const sender = sessions.get(row.sender.sessionId);
  return (
    sender !== undefined &&
    sender.leaseOwner === row.sender.owner &&
    sender.leaseFence === row.sender.fence &&
    sender.leaseExpiresAt !== null &&
    !Deadline.isExpired(row.createdAt, sender.leaseExpiresAt)
  );
}

function validInboxChild(
  sessions: ReadonlyMap<string, LedgerSession.Row>,
  actions: ReadonlyMap<string, LedgerAction.Node>,
  row: Inbox.Commit,
  child: LedgerSession.Materialize,
): boolean {
  if (
    (child.row.parentId !== null && child.row.parentId !== row.sender?.sessionId) ||
    child.row.id !== row.sessionId ||
    child.row.revision !== 0 ||
    child.initialAction.sessionId !== row.sessionId ||
    child.initialAction.parentId !== null ||
    child.initialAction.kind !== "session.configure" ||
    row.parentActionId !== null ||
    sessions.has(row.sessionId) ||
    actions.has(row.id) ||
    actions.has(child.initialAction.id) ||
    child.initialAction.id === row.id
  )
    return false;
  return true;
}

function withinChildLimits(
  sessions: ReadonlyMap<string, LedgerSession.Row>,
  openChildCount: (parentId: string) => number,
  parentId: string | null,
  limits: Inbox.Commit["limits"],
): boolean {
  if (parentId === null) return true;
  if (limits === undefined || openChildCount(parentId) >= limits.fanout) return false;
  let depth = 1;
  let ancestor = sessions.get(parentId);
  while (ancestor?.parentId !== null) {
    if (ancestor === undefined) throw new Error("session ancestry is missing");
    depth += 1;
    ancestor = sessions.get(ancestor.parentId);
  }
  return depth <= limits.depth;
}

function restore<K, V>(target: Map<K, V>, snapshot: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

function appendMemoryAction(
  sessions: Map<string, LedgerSession.Row>,
  actions: Map<string, LedgerAction.Node>,
  alarms: Map<string, Alarm.Row>,
  input: LedgerAction.Append,
  expectedRevision: number,
): LedgerAction.Receipt | undefined {
  const session = sessions.get(input.sessionId);
  if (session === undefined || session.revision !== expectedRevision) return undefined;
  if (actions.has(input.id) || !hasValidParent(actions, input)) return undefined;
  const action = LedgerAction.Node.parse({ ...input, ordinal: expectedRevision + 1 });
  actions.set(action.id, action);
  sessions.set(session.id, { ...session, revision: expectedRevision + 1 });
  if (action.kind === "request" || action.kind === "reply") {
    const effect = action.effect.value;
    if (
      effect !== null &&
      typeof effect === "object" &&
      !Array.isArray(effect) &&
      effect.phase === "state"
    ) {
      const request = SessionTransition.Request.parse(effect.request);
      const id = `${request.requestId}:deadline`;
      const existing = alarms.get(id);
      alarms.set(
        id,
        Alarm.Row.parse({
          ...(existing ?? {
            id,
            sessionId: request.sessionId,
            kind: "at",
            fireAt: request.deadline,
            spec: {
              encodingVersion: 1,
              value: { kind: "request_deadline", requestId: request.requestId },
            },
            createdAt: request.createdAt,
          }),
          status:
            request.state === "open"
              ? "armed"
              : request.state === "expired"
                ? "fired"
                : "cancelled",
          updatedAt: action.ts,
        }),
      );
    }
  }
  return { action, revision: expectedRevision + 1 };
}

function commitMemorySession(
  sessions: Map<string, LedgerSession.Row>,
  actions: Map<string, LedgerAction.Node>,
  inbox: Map<string, Inbox.Row>,
  alarms: Map<string, Alarm.Row>,
  request: LedgerSession.Commit,
): LedgerSession.CommitResult | undefined {
  const current = sessions.get(request.sessionId);
  if (current === undefined) return undefined;
  const refusal = sessionAuthorityRefusal(actions, request, current);
  if (refusal !== undefined) return refusal;
  if (!validSessionInboxOwnership(request)) {
    return memoryRefusal("inbox", current);
  }
  if (!validInboxConsumption(inbox, request)) return memoryRefusal("inbox", current);
  if (!validActionBatch(actions, request.actions, request.sessionId)) {
    return memoryRefusal("revision", current);
  }

  const receipts: LedgerAction.Receipt[] = [];
  let revision = current.revision;
  for (const action of request.actions) {
    const receipt = appendMemoryAction(sessions, actions, alarms, action, revision);
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

function sessionAuthorityRefusal(
  actions: ReadonlyMap<string, LedgerAction.Node>,
  request: LedgerSession.Commit,
  current: LedgerSession.Row,
): LedgerSession.CommitResult | undefined {
  if (
    current.leaseOwner !== request.owner ||
    current.leaseFence !== request.fence ||
    current.leaseExpiresAt === null ||
    Deadline.isExpired(request.now, current.leaseExpiresAt)
  ) {
    return memoryRefusal("stale", current);
  }
  if (current.revision !== request.expectedRevision) return memoryRefusal("revision", current);
  if (
    request.requestCount !== undefined &&
    pendingRequestCount(actions, request.requestCount.since) !== request.requestCount.count
  ) {
    return memoryRefusal("revision", current);
  }
  return undefined;
}

function validSessionInboxOwnership(request: LedgerSession.Commit): boolean {
  if (request.receive !== undefined && request.receive.sessionId !== request.sessionId) {
    return false;
  }
  if (
    request.admit !== undefined &&
    (request.admit.createSession?.row.parentId !== request.sessionId ||
      request.admit.sender?.sessionId !== request.sessionId ||
      request.admit.sender.owner !== request.owner ||
      request.admit.sender.fence !== request.fence)
  )
    return false;
  return true;
}

class MemorySessionCommitRefused extends Error {
  constructor(readonly result: LedgerSession.CommitResult) {
    super("session commit refused");
  }
}

function pendingRequestCount(
  actions: ReadonlyMap<string, LedgerAction.Node>,
  since: number,
): number {
  const requests = new Map<string, SessionTransition.Request>();
  for (const action of [...actions.values()].sort((left, right) => left.ordinal - right.ordinal)) {
    if (action.kind !== "request" && action.kind !== "reply") continue;
    const effect = action.effect.value;
    if (
      effect === null ||
      typeof effect !== "object" ||
      Array.isArray(effect) ||
      effect.phase !== "state"
    )
      continue;
    const request = SessionTransition.Request.parse(effect.request);
    requests.set(request.requestId, request);
  }
  return [...requests.values()].filter(
    (request) =>
      request.state === "open" && request.mode === "approval" && request.createdAt > since,
  ).length;
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
