import { Alarm, canonicalDigest, type Inbox, LedgerAction } from "@openomni/protocol";

export function inboxAppend(row: Inbox.Commit): LedgerAction.Append {
  return LedgerAction.Append.parse({
    id: row.id,
    parentId: row.parentActionId,
    sessionId: row.sessionId,
    kind: "prompt",
    intent: row.origin,
    effect: { encodingVersion: 1, value: { inboxKind: row.kind, content: row.content } },
    irreversible: true,
    ts: row.createdAt,
  });
}

export function alarmAppend(input: Alarm.Arm): LedgerAction.Append {
  return LedgerAction.Append.parse({
    id: input.id,
    parentId: null,
    sessionId: input.sessionId,
    kind: "alarm.arm",
    intent: { encodingVersion: 1, value: { kind: input.kind, fireAt: input.fireAt } },
    effect: {
      encodingVersion: 1,
      value:
        input.spec === undefined
          ? { status: "armed" }
          : { status: "armed", spec: input.spec.value },
    },
    revert: { encodingVersion: 1, value: { op: "cancel", id: input.id } },
    ts: input.fireAt,
  });
}

export interface AlarmOccurrence {
  readonly actionId: string;
  readonly inboxId: string;
  readonly status: Alarm.Status;
  readonly content: string;
  readonly terminal: boolean;
}

/**
 * The single admission judgment for one alarm delivery. Identity, fence,
 * consecutive-batch dedupe, the watch deadline and the compiled notification
 * budget are all decided here from the committed row and its persisted spec;
 * evaluators only capture what they observed. `undefined` means commit nothing.
 */
export function alarmOccurrence(row: Alarm.Row, input: Alarm.Fire): AlarmOccurrence | undefined {
  if (
    row.status !== "armed" ||
    row.epoch !== input.epoch ||
    row.fence !== input.fence ||
    input.at < row.fireAt
  )
    return undefined;
  const spec = row.kind === "watch" ? Alarm.WatchSpec.parse(row.spec?.value) : undefined;
  const expired =
    spec?.watch.timeout_ms !== undefined && input.at >= row.fireAt + spec.watch.timeout_ms;
  if (
    !(expired || input.terminal) &&
    input.batchHash !== undefined &&
    row.lastBatch === input.batchHash
  )
    return undefined;
  const identity = {
    actionId: Alarm.occurrenceId(row.id, row.epoch, input.sourceKey),
    inboxId: canonicalDigest(["alarm.inbox", row.id, row.epoch, input.sourceKey]),
  };
  if (expired)
    return {
      ...identity,
      status: "fired",
      terminal: true,
      content: JSON.stringify({
        alarmId: row.id,
        epoch: row.epoch,
        reason: "timeout",
        exitCode: null,
      }),
    };
  if (input.terminal || spec === undefined)
    return { ...identity, status: "fired", terminal: true, content: input.content };
  if (row.notifications >= spec.notificationLimit)
    return {
      ...identity,
      status: "paused",
      terminal: false,
      content: JSON.stringify({
        alarmId: row.id,
        epoch: row.epoch,
        reason: "wake_budget",
        status: "paused",
      }),
    };
  return { ...identity, status: "armed", terminal: false, content: input.content };
}
