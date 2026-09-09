import { type Alarm, type Inbox, LedgerAction } from "@openomni/protocol";
type AlarmOccurrence = {
  readonly actionId: string;
  readonly inboxId: string;
  readonly status: Alarm.Status;
  readonly content: string;
  readonly terminal: boolean;
};

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

/** The `alarm.fired`/`alarm.paused` action one admitted occurrence commits under its alarm. */
export function alarmFired(
  row: Alarm.Row,
  input: Alarm.Fire,
  occurrence: AlarmOccurrence,
): LedgerAction.Append {
  return {
    id: occurrence.actionId,
    parentId: row.id,
    sessionId: row.sessionId,
    kind: occurrence.status === "paused" ? "alarm.paused" : "alarm.fired",
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
    effect: {
      encodingVersion: 1,
      value: { status: occurrence.status, content: occurrence.content },
    },
    irreversible: true,
    ts: input.at,
  };
}

/** The prompt the occurrence leaves in the session inbox, parented on its fired action. */
export function alarmPrompt(
  row: Alarm.Row,
  input: Alarm.Fire,
  occurrence: AlarmOccurrence,
): Inbox.Commit {
  return {
    id: occurrence.inboxId,
    sessionId: row.sessionId,
    kind: "prompt",
    content: occurrence.content,
    origin: { encodingVersion: 1, value: row.id },
    createdAt: input.at,
    parentActionId: occurrence.actionId,
  };
}
