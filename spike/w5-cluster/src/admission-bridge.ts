// Check 4 bridge: cluster entity mailbox (FIFO drain) -> the W1 pure admission
// contract. The entity would drain MailboxItems in FIFO order; this module maps
// them to the exact Inbox.Row shape the inbox-table path feeds into
// decideSessionAdmission, so both planes run the SAME pure function over the
// SAME rows and must agree decision-for-decision.
import { Inbox, type LedgerSession } from "@openomni/protocol";
// SPIKE-ONLY deep import: decideSessionAdmission is not on the @openomni/agent
// public surface (packages/agent/src/index.ts does not export it), so the spike
// reaches into the source relatively. Never do this outside the spike.
import { decideSessionAdmission } from "../../../packages/agent/src/session-admission";

/** The snapshot decideSessionAdmission consumes (type not exported upstream). */
export type AdmissionSnapshot = Parameters<typeof decideSessionAdmission>[0];
export type AdmissionDecision = ReturnType<typeof decideSessionAdmission>;
export type OpenTurn = NonNullable<AdmissionSnapshot["open"]>;
export type TurnTerminal = NonNullable<AdmissionSnapshot["terminal"]>;

/**
 * What a Session entity would drain from its cluster mailbox, in FIFO order.
 * `kind` uses the real Inbox kinds ("interrupt" is the control/signal kind;
 * there is no separate "signal" kind in the durable schema).
 */
export interface MailboxItem {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: Inbox.Kind; // "prompt" | "interrupt" | "resume"
  readonly content: string;
  readonly receivedAt: number;
}

/**
 * FIFO mailbox -> pending Inbox.Row projection. Ordinal is the FIFO position
 * (the mailbox IS the order; there is no separate ordinal column to consult),
 * status is always "pending" (an entity never re-reads consumed messages), and
 * consumed_by/consumed_at are always null for the same reason.
 */
export function mailboxToPending(items: readonly MailboxItem[]): readonly Inbox.Row[] {
  return items.map((item, index) =>
    Inbox.Row.parse({
      id: item.id,
      sessionId: item.sessionId,
      kind: item.kind,
      content: item.content,
      origin: {
        encodingVersion: 1,
        value: { kind: "cluster_message", envelopeId: item.id },
      },
      status: "pending",
      consumedBy: null,
      consumedAt: null,
      createdAt: item.receivedAt,
      ordinal: index + 1,
    }),
  );
}

/** Build the exact snapshot the inbox-table path would build, from mailbox items. */
export function toAdmissionSnapshot(
  row: LedgerSession.Row,
  mailbox: readonly MailboxItem[],
  open?: OpenTurn,
  terminal?: TurnTerminal,
): AdmissionSnapshot {
  return {
    row,
    pending: mailboxToPending(mailbox),
    ...(open === undefined ? {} : { open }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

/** The decision the entity mailbox plane produces for this drain. */
export function decideFromMailbox(
  row: LedgerSession.Row,
  items: readonly MailboxItem[],
  open?: OpenTurn,
  terminal?: TurnTerminal,
): AdmissionDecision {
  return decideSessionAdmission(toAdmissionSnapshot(row, items, open, terminal));
}
