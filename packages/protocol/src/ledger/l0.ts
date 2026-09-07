import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { NamedError } from "../error/index.js";
import { PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";

const Identifier = z.string().min(1);
const NullableIdentifier = Identifier.nullable();

export const EncodedPayload = z
  .object({
    encodingVersion: z.literal(1),
    value: PlainValueSchema,
  })
  .strict();
export type EncodedPayload = z.infer<typeof EncodedPayload>;

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

const InboxWrite = z
  .object({
    id: Identifier,
    sessionId: Identifier,
    kind: z.enum(["prompt", "interrupt", "resume"]),
    content: z.string(),
    origin: EncodedPayload,
    createdAt: EpochMs,
    parentActionId: NullableIdentifier.default(null),
  })
  .strict();

export namespace LedgerSession {
  export const Role = z.enum(["resident", "worker"]);
  export type Role = z.infer<typeof Role>;

  export const State = z.enum(["idle", "running", "interrupted"]);
  export type State = z.infer<typeof State>;

  export const GenerationPointers = z
    .object({
      toolsGeneration: z.number().int().nonnegative(),
      systemHash: z.string(),
      policyGeneration: z.number().int().nonnegative(),
    })
    .strict();
  export type GenerationPointers = z.infer<typeof GenerationPointers>;

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
      toolsGeneration: z.number().int().nonnegative().default(0),
      systemHash: z.string().default(""),
      policyGeneration: z.number().int().nonnegative().default(0),
    })
    .strict();
  export type Row = z.infer<typeof Row>;

  export const Materialize = z
    .object({
      row: Row,
      initialAction: LedgerAction.Append,
    })
    .strict();
  export type Materialize = z.infer<typeof Materialize>;

  export const MaterializeResult = z.discriminatedUnion("created", [
    z.object({ created: z.literal(true), row: Row, receipt: LedgerAction.Receipt }).strict(),
    z.object({ created: z.literal(false), row: Row }).strict(),
  ]);
  export type MaterializeResult = z.infer<typeof MaterializeResult>;

  export const AcquireLease = z
    .object({
      sessionId: Identifier,
      owner: Identifier,
      expectedFence: z.number().int().nonnegative(),
      now: EpochMs,
      expiresAt: EpochMs,
    })
    .strict()
    .refine((input) => input.expiresAt > input.now, {
      message: "lease expiry must be after acquisition time",
      path: ["expiresAt"],
    });
  export type AcquireLease = z.infer<typeof AcquireLease>;

  export const LeaseResult = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), fence: z.number().int().positive() }).strict(),
    z
      .object({
        ok: z.literal(false),
        reason: z.literal("held"),
        holder: Identifier,
        expiresAt: EpochMs,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        reason: z.literal("stale"),
        currentFence: z.number().int().nonnegative(),
      })
      .strict(),
  ]);
  export type LeaseResult = z.infer<typeof LeaseResult>;

  export const RenewLease = z
    .object({
      sessionId: Identifier,
      owner: Identifier,
      fence: z.number().int().positive(),
      now: EpochMs,
      expiresAt: EpochMs,
    })
    .strict()
    .refine((input) => input.expiresAt > input.now, {
      message: "lease expiry must be after heartbeat time",
      path: ["expiresAt"],
    });
  export type RenewLease = z.infer<typeof RenewLease>;

  export const Commit = z
    .object({
      sessionId: Identifier,
      owner: Identifier,
      fence: z.number().int().positive(),
      now: EpochMs,
      expectedRevision: z.number().int().nonnegative(),
      actions: z.array(LedgerAction.Append),
      consumeInboxIds: z.array(Identifier),
      state: State,
      generation: GenerationPointers.optional(),
      releaseLease: z.boolean(),
      deliveries: z.array(InboxWrite).optional(),
    })
    .strict();
  export type Commit = z.infer<typeof Commit>;

  export const CommitResult = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), row: Row, receipts: z.array(LedgerAction.Receipt) }).strict(),
    z
      .object({
        ok: z.literal(false),
        reason: z.enum(["stale", "revision", "inbox"]),
        currentFence: z.number().int().nonnegative(),
        currentRevision: z.number().int().nonnegative(),
      })
      .strict(),
  ]);
  export type CommitResult = z.infer<typeof CommitResult>;
}

export namespace SessionGeneration {
  export const ToolCategory = z.enum(["query", "mutation", "authority", "execution"]);
  export type ToolCategory = z.infer<typeof ToolCategory>;

  export const Tool = z
    .object({
      name: Identifier,
      inputSchema: PlainValueSchema,
      category: ToolCategory,
      sequential: z.literal(true).optional(),
    })
    .strict();
  export type Tool = z.infer<typeof Tool>;

  export const SystemBlock = z
    .object({
      id: Identifier,
      source: Identifier,
      content: z.string(),
    })
    .strict();
  export type SystemBlock = z.infer<typeof SystemBlock>;

  export const Snapshot = z
    .object({
      generation: z.number().int().positive(),
      revertTo: z.number().int().nonnegative(),
      tools: z.array(Tool),
      toolsHash: z.string().min(1),
      systemPreset: z.string(),
      systemBlocks: z.array(SystemBlock),
      systemValue: z.string(),
      systemHash: z.string().min(1),
      policyGeneration: z.number().int().nonnegative(),
    })
    .strict();
  export type Snapshot = z.infer<typeof Snapshot>;

  export const ConfigureIntent = z
    .object({
      operation: z.enum(["create", "tools.add", "tools.remove", "system.blocks.set", "revert"]),
    })
    .strict();
  export type ConfigureIntent = z.infer<typeof ConfigureIntent>;

  export const ConfigureEffect = z
    .object({
      phase: z.literal("configured"),
      snapshot: Snapshot,
    })
    .strict();
  export type ConfigureEffect = z.infer<typeof ConfigureEffect>;

  export const ConfigureRevert = z
    .object({
      generation: z.number().int().nonnegative(),
    })
    .strict();
  export type ConfigureRevert = z.infer<typeof ConfigureRevert>;

  export const ConfigureReceipt = z
    .object({
      generation: z.number().int().positive(),
      revertTo: z.number().int().nonnegative(),
    })
    .strict();
  export type ConfigureReceipt = z.infer<typeof ConfigureReceipt>;

  export const ConfigureError = NamedError.create(
    "SessionConfigureError",
    z
      .object({
        code: z.enum(["duplicate_tool", "duplicate_block", "denied", "stale"]),
        message: z.string().min(1),
      })
      .strict(),
  );
  export type ConfigureError = InstanceType<typeof ConfigureError>;
}

export namespace SessionTurn {
  export const Boundary = z.enum(["before_llm", "after_llm", "after_tools"]);
  export type Boundary = z.infer<typeof Boundary>;

  export const Message = z
    .object({
      role: z.enum(["user", "assistant"]),
      text: z.string(),
    })
    .strict();
  export type Message = z.infer<typeof Message>;

  const PinnedGeneration = z
    .object({
      toolsGeneration: z.number().int().positive(),
      toolsHash: z.string().min(1),
      systemHash: z.string().min(1),
      policyGeneration: z.number().int().nonnegative(),
    })
    .strict();

  export const Intent = PinnedGeneration.extend({
    phase: z.literal("intent"),
    resultId: Identifier,
    inboxIds: z.array(Identifier),
    resumeCount: z.number().int().nonnegative(),
    boundaryActionId: NullableIdentifier,
  }).strict();
  export type Intent = z.infer<typeof Intent>;

  export const Resume = PinnedGeneration.extend({
    phase: z.literal("resume"),
    turnId: Identifier,
    resultId: Identifier,
    resumeCount: z.number().int().positive(),
    boundaryActionId: NullableIdentifier,
  }).strict();
  export type Resume = z.infer<typeof Resume>;

  export const Checkpoint = z
    .object({
      phase: z.literal("checkpoint"),
      turnId: Identifier,
      resultId: Identifier,
      resumeCount: z.number().int().nonnegative(),
      boundaryActionId: NullableIdentifier,
      boundary: Boundary,
    })
    .strict();
  export type Checkpoint = z.infer<typeof Checkpoint>;

  export const TerminalIntent = z
    .object({
      phase: z.literal("terminal"),
      turnId: Identifier,
    })
    .strict();
  export type TerminalIntent = z.infer<typeof TerminalIntent>;

  export const TerminalKind = z.enum(["result", "interrupted", "error", "waiting"]);
  export type TerminalKind = z.infer<typeof TerminalKind>;

  export const Terminal = z
    .object({
      phase: z.literal("terminal"),
      turnId: Identifier,
      kind: TerminalKind,
      reason: z.literal("live_wait").optional(),
      alarmIds: z.array(Identifier).min(1).optional(),
      text: z.string(),
      boundaryActionId: NullableIdentifier,
      resumeCount: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((terminal, context) => {
      if (
        terminal.kind === "waiting" &&
        (terminal.reason !== "live_wait" || terminal.alarmIds === undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["alarmIds"],
          message: "waiting requires live alarm identities",
        });
      }
      if (
        terminal.kind !== "waiting" &&
        (terminal.reason !== undefined || terminal.alarmIds !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["kind"],
          message: "only waiting carries live-wait evidence",
        });
      }
    });
  export type Terminal = z.infer<typeof Terminal>;

  export const Delivery = z
    .object({
      phase: z.literal("delivery"),
      turnId: Identifier,
      inboxId: Identifier,
      kind: z.enum(["prompt", "interrupt", "resume"]),
      content: z.string(),
      origin: EncodedPayload,
      boundary: Boundary,
    })
    .strict();
  export type Delivery = z.infer<typeof Delivery>;

  export const Pending = z
    .object({
      phase: z.literal("pending"),
    })
    .strict();
  export type Pending = z.infer<typeof Pending>;

  export const Tail = z
    .object({
      turnId: Identifier,
      state: LedgerSession.State,
      startedAt: EpochMs,
      terminal: z
        .object({
          kind: TerminalKind,
          actionId: Identifier,
          at: EpochMs,
        })
        .strict()
        .optional(),
      messages: z.array(Message),
    })
    .strict();
  export type Tail = z.infer<typeof Tail>;

  export const Snapshot = z
    .object({
      id: Identifier,
      parentId: NullableIdentifier,
      role: LedgerSession.Role,
      revision: z.number().int().nonnegative(),
      state: LedgerSession.State,
      lease: z
        .object({
          owner: NullableIdentifier,
          fence: z.number().int().nonnegative(),
          expiresAt: EpochMs.nullable(),
        })
        .strict(),
      toolsGeneration: z.number().int().nonnegative(),
      systemHash: z.string(),
      policyGeneration: z.number().int().nonnegative(),
      openTurnId: Identifier.optional(),
      turns: z.array(Tail),
    })
    .strict();
  export type Snapshot = z.infer<typeof Snapshot>;

  export interface Watch {
    readonly snapshot: Snapshot;
    readonly subscribe: (handler: (observation: Observation) => void) => () => void;
    readonly unsubscribe: () => void;
  }

  export const Observation = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("revision"),
        sessionId: Identifier,
        revision: z.number().int().positive(),
        actionId: Identifier,
        actionKind: LedgerAction.Kind,
      })
      .strict(),
    z
      .object({
        kind: z.literal("gap"),
        sessionId: Identifier,
        from: z.number().int().nonnegative(),
        to: z.number().int().positive(),
      })
      .strict(),
  ]);
  export type Observation = z.infer<typeof Observation>;
}

export namespace Inbox {
  export const ReplyOrigin = z
    .object({
      kind: z.enum(["child_terminal", "external_reply"]),
      messageId: Identifier,
      sourceActionId: Identifier,
      replyTo: Identifier,
      childSessionId: Identifier.optional(),
      terminalKind: SessionTurn.TerminalKind.optional(),
    })
    .strict();
  export type ReplyOrigin = z.infer<typeof ReplyOrigin>;

  export const MessageOrigin = z
    .object({
      kind: z.literal("message"),
      messageId: Identifier,
      senderSessionId: Identifier,
      replyTo: Identifier.optional(),
      deadline: EpochMs.optional(),
      sourceActionId: Identifier,
    })
    .strict();
  export type MessageOrigin = z.infer<typeof MessageOrigin>;

  export const Kind = z.enum(["prompt", "interrupt", "resume"]);
  export type Kind = z.infer<typeof Kind>;

  export const Status = z.enum(["pending", "consumed"]);
  export type Status = z.infer<typeof Status>;

  export const Row = z
    .object({
      id: Identifier,
      sessionId: Identifier,
      kind: Kind,
      content: z.string(),
      origin: EncodedPayload,
      status: Status,
      consumedBy: NullableIdentifier,
      consumedAt: EpochMs.nullable(),
      createdAt: EpochMs,
      ordinal: z.number().int().positive(),
    })
    .strict();
  export type Row = z.infer<typeof Row>;
  export type Origin = EncodedPayload;

  export const Commit = Row.omit({
    status: true,
    consumedBy: true,
    consumedAt: true,
    ordinal: true,
  })
    .extend({
      parentActionId: NullableIdentifier.default(null),
      sender: z
        .object({
          sessionId: Identifier,
          owner: Identifier,
          fence: z.number().int().positive(),
        })
        .strict()
        .optional(),
      createSession: LedgerSession.Materialize.optional(),
      limits: z
        .object({ fanout: z.number().int().nonnegative(), depth: z.number().int().nonnegative() })
        .strict()
        .optional(),
    })
    .refine(
      (row) =>
        row.createSession === undefined ||
        row.createSession.row.parentId === null ||
        row.limits !== undefined,
      {
        path: ["limits"],
        message: "child materialization requires pinned admission limits",
      },
    );
  export type Commit = z.infer<typeof Commit>;

  export interface Port {
    commit(row: Commit): Row;
  }
}

export namespace Alarm {
  export const MessageDeadline = z
    .object({
      kind: z.literal("message_deadline"),
      messageId: Identifier,
      sourceActionId: Identifier,
      replyTo: Identifier.optional(),
      createdAt: EpochMs,
      generation: LedgerSession.GenerationPointers,
    })
    .strict();
  export type MessageDeadline = z.infer<typeof MessageDeadline>;

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

export namespace PolicyRow {
  export const Phase = z.enum(["pre", "post"]);
  export type Phase = z.infer<typeof Phase>;

  export const Row = z
    .object({
      name: Identifier,
      kind: Identifier,
      phase: Phase,
      match: EncodedPayload,
      verdict: EncodedPayload,
      priority: z.number().int(),
      generation: z.number().int().positive(),
    })
    .strict();
  export type Row = z.infer<typeof Row>;
}
