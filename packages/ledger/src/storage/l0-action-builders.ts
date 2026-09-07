import { LedgerAction, Alarm, type Inbox, type LedgerSession } from "@openomni/protocol";

export function messageDeadlineArm(
  input: {
    readonly messageId: string;
    readonly sessionId: string;
    readonly sourceActionId: string;
    readonly fireAt: number;
    readonly createdAt: number;
    readonly replyTo?: string;
  },
  sender: LedgerSession.Row,
): Alarm.Arm {
  const spec = Alarm.MessageDeadline.parse({
    kind: "message_deadline",
    messageId: input.messageId,
    sourceActionId: input.sourceActionId,
    createdAt: input.createdAt,
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    generation: {
      toolsGeneration: sender.toolsGeneration,
      systemHash: sender.systemHash,
      policyGeneration: sender.policyGeneration,
    },
  });
  return {
    id: `${input.sourceActionId}:deadline`,
    sessionId: input.sessionId,
    kind: "at",
    fireAt: input.fireAt,
    spec: { encodingVersion: 1, value: spec },
  };
}

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

export function messageAnswerAppend(input: {
  sessionId: string;
  sourceActionId: string;
  messageId: string;
  at: number;
  state: "answered" | "timed_out";
}): LedgerAction.Append {
  return {
    id: `${input.sourceActionId}:answer`,
    parentId: input.sourceActionId,
    sessionId: input.sessionId,
    kind: "message",
    intent: { encodingVersion: 1, value: { phase: "answer", messageId: input.messageId } },
    effect: { encodingVersion: 1, value: { state: input.state } },
    irreversible: true,
    ts: input.at,
  };
}

export function messageTimeoutInbox(
  alarm: Alarm.Row,
  spec: Alarm.MessageDeadline,
  at: number,
): Inbox.Commit {
  return {
    id: `${spec.sourceActionId}:timeout`,
    sessionId: alarm.sessionId,
    parentActionId: `${spec.sourceActionId}:answer`,
    kind: "prompt",
    content: JSON.stringify({
      type: "timeout",
      messageId: spec.messageId,
      replyTo: spec.replyTo ?? spec.messageId,
    }),
    createdAt: at,
    origin: {
      encodingVersion: 1,
      value: {
        kind: "message_timeout",
        messageId: spec.messageId,
        sourceActionId: spec.sourceActionId,
        replyTo: spec.replyTo ?? spec.messageId,
        waitedMs: at - spec.createdAt,
      },
    },
  };
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
