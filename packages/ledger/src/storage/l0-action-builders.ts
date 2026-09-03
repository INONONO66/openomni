import { LedgerAction, type Alarm, type Inbox } from "@openomni/protocol";

export function inboxAction(row: Inbox.Commit, ordinal: number): LedgerAction.Node {
  return LedgerAction.Node.parse({
    id: row.id,
    parentId: null,
    sessionId: row.sessionId,
    kind: "prompt",
    intent: row.origin,
    effect: { encodingVersion: 1, value: { inboxKind: row.kind, content: row.content } },
    irreversible: true,
    ts: row.createdAt,
    ordinal,
  });
}

export function alarmAction(input: Alarm.Arm, ordinal: number): LedgerAction.Node {
  return LedgerAction.Node.parse({
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
    ordinal,
  });
}
