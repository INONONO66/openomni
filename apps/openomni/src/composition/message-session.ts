import { Effect, FiberRef } from "effect";
import { ForeignFailure } from "@openomni/agent";
import { SessionHandleStore, type LedgerError } from "@openomni/ledger";
import { Inbox, Gateway, type LedgerSession, type SessionGeneration } from "@openomni/protocol";
import { SendAdmissionConflict, type createGatewayRouter } from "@openomni/channels";
import { outboundMessage } from "./terminal-message";

type Ports = Parameters<typeof createGatewayRouter>[0];

export function commitMessageInbox(
  input: Inbox.Commit,
): Effect.Effect<Inbox.Row, LedgerError | ForeignFailure> {
  return Effect.gen(function* () {
    const outbound = yield* FiberRef.get(outboundMessage);
    const message = outbound?.input.message;
    if (
      message !== undefined &&
      (input.id !== message.messageId ||
        input.sessionId !== message.destinationSessionId ||
        input.content !== message.content)
    ) {
      return yield* new ForeignFailure({
        operation: "message.commit",
        cause: "outbound inbox binding mismatch",
      });
    }
    const received = yield* SessionHandleStore.commitReceivedMessage(input);
    if (outbound !== undefined) outbound.receipt = received.receipt;
    return received.row;
  });
}

export function messageMaterialization(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  readonly tools: readonly SessionGeneration.Tool[];
  readonly bundles?: readonly string[];
  readonly preset: string;
  readonly runner: string;
  readonly at: number;
}): LedgerSession.Materialize {
  const snapshot = SessionHandleStore.generationSnapshot({
    generation: 1,
    revertTo: 0,
    tools: input.tools,
    bundles: input.bundles ?? [],
    system: {
      preset: input.preset,
      blocks: [{ id: "runner", source: "app:runner", content: input.runner }],
    },
    policyGeneration: SessionHandleStore.currentPolicyGeneration(),
  });
  return {
    row: {
      id: input.id,
      parentId: input.parentId,
      role: input.role,
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      revision: 0,
      state: "idle",
      toolsGeneration: snapshot.generation,
      systemHash: snapshot.systemHash,
      policyGeneration: snapshot.policyGeneration,
    },
    initialAction: SessionHandleStore.configureAction({
      id: crypto.randomUUID(),
      sessionId: input.id,
      parentId: null,
      operation: "create",
      snapshot,
      at: input.at,
    }),
  };
}

function sessionDepth(
  parentId: string | null,
  rows: ReturnType<typeof SessionHandleStore.listRows>,
) {
  let depth = 1;
  let parent = parentId;
  while (parent !== null) {
    depth += 1;
    parent = rows.find((row) => row.id === parent)?.parentId ?? null;
  }
  return depth;
}

function recipientRelation(
  source: ReturnType<typeof SessionHandleStore.row>,
  recipient: ReturnType<typeof SessionHandleStore.row> | undefined,
  send: Parameters<Ports["prepare"]>[1],
) {
  return {
    ...(recipient === undefined
      ? send.to.kind === "new_session"
        ? { targetRole: send.to.role }
        : {}
      : { targetRole: recipient.role }),
    parentChild:
      recipient === undefined ||
      recipient.id === source.id ||
      recipient.parentId === source.id ||
      source.parentId === recipient.id,
  };
}

function prepareExternal(
  materialize: (
    id: string,
    parentId: string | null,
    role: LedgerSession.Role,
    runner: string,
  ) => LedgerSession.Materialize,
  send: Parameters<Ports["prepare"]>[1],
  target: string,
  messageId: string,
): Effect.Effect.Success<ReturnType<Ports["prepare"]>> {
  const exists = SessionHandleStore.listRows().some((row) => row.id === target);
  const source =
    exists && send.replyTo !== undefined
      ? SessionHandleStore.messageActionByPlatformId(target, send.replyTo)
      : undefined;
  return {
    target,
    ...(source === undefined || send.replyTo === undefined
      ? {}
      : {
          origin: Inbox.ReplyOrigin.parse({
            kind: "external_reply",
            messageId: send.replyTo,
            sourceActionId: source.id,
            replyTo: send.replyTo,
          }),
        }),
    ...(!exists ? { createSession: materialize(target, null, "resident", "resident") } : {}),
    message: {
      sender: "external",
      eventIdUnique:
        !exists || !SessionHandleStore.inboxRows(target).some((row) => row.id === messageId),
    },
  };
}

function admissionBounds(
  source: ReturnType<typeof SessionHandleStore.row>,
  send: Parameters<Ports["prepare"]>[1],
) {
  return SessionHandleStore.policyRows(source.policyGeneration).flatMap((row) => {
    const match = row.match.value;
    if (
      row.kind !== "message" ||
      row.phase !== "pre" ||
      match === null ||
      typeof match !== "object" ||
      Array.isArray(match)
    )
      return [];
    const parsed = Gateway.RuleTableB.safeParse(match.message);
    if (!parsed.success) return [];
    const rule = parsed.data;
    return rule.senderRole === source.role &&
      rule.effect === "deny" &&
      (rule.targetKind === undefined || rule.targetKind === send.to.kind) &&
      (rule.type === undefined || rule.type === send.type) &&
      (rule.targetRole === undefined ||
        (send.to.kind === "new_session" && rule.targetRole === send.to.role))
      ? [rule.check]
      : [];
  });
}

function withinDeadline(
  outbound: boolean,
  parentDeadline: number | undefined,
  sendDeadline: number | undefined,
): boolean {
  return (
    outbound ||
    parentDeadline === undefined ||
    (sendDeadline !== undefined && sendDeadline <= parentDeadline)
  );
}

export function prepareMessage(
  materialize: (
    id: string,
    parentId: string | null,
    role: LedgerSession.Role,
    runner: string,
  ) => LedgerSession.Materialize,
): Ports["prepare"] {
  return (sender, send, target, messageId) =>
    Effect.gen(function* () {
      if (sender.kind === "external") {
        return prepareExternal(materialize, send, target, messageId);
      }
      const source = SessionHandleStore.row(sender.id);
      if (source.leaseOwner === null)
        return yield* new SendAdmissionConflict({ message: "session sender has no active lease" });
      const rows = SessionHandleStore.listRows();
      const recipient = send.to.kind === "session" ? SessionHandleStore.row(target) : undefined;
      const origins = SessionHandleStore.inboxRows(source.id).flatMap((row) => {
        const parsed = Inbox.MessageOrigin.safeParse(row.origin.value);
        return parsed.success ? [parsed.data] : [];
      });
      const parentDeadline = origins.at(-1)?.deadline;
      const outbound = yield* FiberRef.get(outboundMessage);
      const bounds = admissionBounds(source, send);
      const fanout = bounds.flatMap((check) => (check.kind === "fanout" ? [check.max] : []));
      const depths = bounds.flatMap((check) => (check.kind === "depth" ? [check.max] : []));
      if (send.to.kind === "new_session" && (fanout.length === 0 || depths.length === 0))
        return yield* new SendAdmissionConflict({ message: "child admission bounds missing from pinned policy" });
      const depth = sessionDepth(source.parentId, rows);
      return {
        target,
        ...(outbound === undefined
          ? {}
          : {
              messageId: outbound.input.message.messageId,
              origin: outbound.input.message,
            }),
        sender: { sessionId: sender.id, owner: source.leaseOwner, fence: source.leaseFence },
        ...(send.to.kind === "new_session"
          ? {
              createSession: materialize(target, sender.id, send.to.role, send.to.runner),
              limits: { fanout: Math.min(...fanout), depth: Math.min(...depths) },
            }
          : {}),
        message: {
          sender: "session",
          senderRole: source.role,
          targetKind: send.to.kind,
          ...recipientRelation(source, recipient, send),
          type: send.type,
          fanout: SessionHandleStore.openChildCount(source.id),
          depth,
          // Mandatory terminal mail answers the original request. Its existing
          // alarm/answer CAS owns the bound; a reply must not open another alarm.
          withinParentDeadline: withinDeadline(
            outbound !== undefined,
            parentDeadline,
            send.deadline,
          ),
        },
      };
    });
}
