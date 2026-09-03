import { z } from "zod";
import { PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";
import { BusEvent } from "../bus/index.js";

const Identifier = z.string().min(1);
const NullableIdentifier = Identifier.nullable();

const EncodedPayload = z
  .object({
    encodingVersion: z.literal(1),
    value: PlainValueSchema,
  })
  .strict();

export namespace LedgerAction {
  export const Kind = z.enum([
    "prompt",
    "turn",
    "llm",
    "attempt",
    "tool",
    "message",
    "inbox.deliver",
    "compaction",
    "alarm.arm",
    "alarm.fired",
    "alarm.paused",
    "session.configure",
    "policy.decision",
  ]);
  export type Kind = z.infer<typeof Kind>;

  const BaseNode = z
    .object({
      id: Identifier,
      parentId: NullableIdentifier,
      sessionId: Identifier,
      kind: Kind,
      intent: EncodedPayload,
      effect: EncodedPayload,
      ts: EpochMs,
      ordinal: z.number().int().positive(),
    })
    .strict();

  const RevertibleNode = BaseNode.extend({
    revert: EncodedPayload,
  });
  const IrreversibleNode = BaseNode.extend({
    irreversible: z.literal(true),
  });

  export const Node = z.union([RevertibleNode, IrreversibleNode]);
  export type Node = z.infer<typeof Node>;

  const AppendBase = BaseNode.omit({ ordinal: true });
  export const Append = z.union([
    AppendBase.extend({ revert: EncodedPayload }),
    AppendBase.extend({ irreversible: z.literal(true) }),
  ]);
  export type Append = z.infer<typeof Append>;

  export const Receipt = z
    .object({
      action: Node,
      revision: z.number().int().positive(),
    })
    .strict();
  export type Receipt = z.infer<typeof Receipt>;
}

export namespace LedgerSession {
  export const Role = z.enum(["resident", "worker"]);
  export type Role = z.infer<typeof Role>;

  export const State = z.enum(["idle", "running", "interrupted"]);
  export type State = z.infer<typeof State>;

  export const Row = z
    .object({
      id: Identifier,
      parentId: NullableIdentifier,
      role: Role,
      leaseOwner: NullableIdentifier,
      leaseFence: z.number().int().nonnegative(),
      leaseExpiresAt: EpochMs.nullable(),
      revision: z.number().int().nonnegative(),
      state: State,
    })
    .strict();
  export type Row = z.infer<typeof Row>;
}

export namespace Inbox {
  export const Kind = z.enum(["prompt", "interrupt", "resume"]);
  export type Kind = z.infer<typeof Kind>;

  export const Status = z.enum(["pending", "claimed"]);
  export type Status = z.infer<typeof Status>;

  export const Row = z
    .object({
      id: Identifier,
      sessionId: Identifier,
      kind: Kind,
      content: z.string(),
      origin: EncodedPayload,
      status: Status,
      claimedBy: NullableIdentifier,
      claimedAt: EpochMs.nullable(),
      createdAt: EpochMs,
      ordinal: z.number().int().positive(),
    })
    .strict();
  export type Row = z.infer<typeof Row>;

  export const Commit = Row.omit({ status: true, claimedBy: true, claimedAt: true, ordinal: true });
  export type Commit = z.infer<typeof Commit>;

  export interface Port {
    commit(row: Commit): Row;
  }
}

export namespace Alarm {
  export const Kind = z.enum(["at", "watch"]);
  export type Kind = z.infer<typeof Kind>;

  export const Status = z.enum(["armed", "cancelled", "fired", "paused"]);
  export type Status = z.infer<typeof Status>;

  export const Row = z
    .object({
      id: Identifier,
      sessionId: Identifier,
      kind: Kind,
      fireAt: EpochMs,
      spec: EncodedPayload.optional(),
      status: Status,
      createdAt: EpochMs,
      updatedAt: EpochMs,
    })
    .strict();
  export type Row = z.infer<typeof Row>;

  export const Arm = Row.omit({ status: true, createdAt: true, updatedAt: true });
  export type Arm = z.infer<typeof Arm>;
}

export namespace L0Observation {
  export const ActionCommitted = z
    .object({
      id: Identifier,
      sessionId: Identifier,
      revision: z.number().int().positive(),
      kind: LedgerAction.Kind,
    })
    .strict();
  export type ActionCommitted = z.infer<typeof ActionCommitted>;

  export const ActionCommittedEvent = BusEvent.define("ledger.action.committed", ActionCommitted, {
    visibility: "ephemeral",
  });
}

export interface ObservationSink extends BusEvent.Sink {}

export namespace PolicyRow {
  export const Phase = z.enum(["pre", "post"]);
  export type Phase = z.infer<typeof Phase>;

  export const Row = z
    .object({
      name: Identifier,
      kind: LedgerAction.Kind,
      phase: Phase,
      match: EncodedPayload,
      verdict: EncodedPayload,
      priority: z.number().int(),
      generation: z.number().int().positive(),
    })
    .strict();
  export type Row = z.infer<typeof Row>;
}
