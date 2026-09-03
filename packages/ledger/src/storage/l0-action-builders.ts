import { LedgerAction, type Alarm, type Inbox } from "@openomni/protocol";

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

export function inboxAction(row: Inbox.Commit, ordinal: number): LedgerAction.Node {
  return LedgerAction.Node.parse({ ...inboxAppend(row), ordinal });
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
    irreversible: true,
    ts: input.fireAt,
  });
}

export function alarmAction(input: Alarm.Arm, ordinal: number): LedgerAction.Node {
  return LedgerAction.Node.parse({ ...alarmAppend(input), ordinal });
}
