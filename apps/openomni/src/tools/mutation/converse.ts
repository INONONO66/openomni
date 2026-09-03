import type { ConversationStore, LeaseStore } from "@openomni/ledger";
import type { Delegation } from "@openomni/protocol";
import { newTraceId } from "@openomni/telemetry";
import { z } from "zod";
import { defineTool, ToolRefused } from "../core/define";

export interface ConversePort {
  readonly open: typeof ConversationStore.open;
  readonly get: typeof ConversationStore.get;
  readonly close: typeof ConversationStore.close;
  readonly closeLeases: typeof LeaseStore.closeByConversation;
}
export interface LeasePort {
  readonly issue: typeof LeaseStore.issue;
  readonly getDelegation: (delegationId: string) => Delegation.Record | undefined;
}
const Operation = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("open"),
      contactId: z.string().min(1).describe("Registered actor the window reaches."),
      endpointId: z
        .string()
        .min(1)
        .describe("Allocated endpoint of that actor the window is pinned to."),
      timeoutMs: z.number().int().positive().describe("How long the window stays open from now."),
      maxOutbound: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Outbound message cap inside the window (default 8)."),
      maxInbound: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Inbound message cap before demotion (default 32)."),
    })
    .strict(),
  z
    .object({
      op: z.literal("close"),
      conversationId: z.string().min(1).describe("Window to settle."),
    })
    .strict(),
  z
    .object({
      op: z.literal("lease"),
      delegationId: z.string().min(1).describe("Open delegation that will hold the lease."),
      conversationId: z.string().min(1).describe("Open conversation whose budget is carved."),
      maxOutbound: z
        .number()
        .int()
        .positive()
        .describe("Outbound sends allocated from the window."),
    })
    .strict(),
]);
const Input = z.object({ operation: Operation }).strict();
const Output = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("open"),
      id: z.string(),
      contactId: z.string(),
      expiresAt: z.number(),
      maxOutbound: z.number(),
      maxInbound: z.number(),
    })
    .strict(),
  z
    .object({
      op: z.literal("close"),
      result: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("unchanged"),
            conversationId: z.string(),
            closedBy: z.string().nullable().optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("closed"),
            conversationId: z.string(),
            revoked: z.number().int().nonnegative(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("lease"),
      id: z.string(),
      holderDelegationId: z.string(),
      contactId: z.string(),
      conversationId: z.string(),
      maxOutbound: z.number(),
      expiresAt: z.number(),
    })
    .strict(),
]);

export function createConverseTool(conversations: ConversePort, leases: LeasePort) {
  return defineTool({
    name: "converse",
    category: "mutation",
    description:
      "Open or close a bounded conversation window, or carve a delegation lease from one. Use op=open|close|lease.",
    input: Input,
    output: Output,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async ({ operation }, ctx) => {
      if (operation.op === "open") {
        const open = operation;
        const at = Date.now();
        try {
          const record = conversations.open(
            {
              id: `conv:${ctx.sessionId}:${crypto.randomUUID()}`,
              contactId: open.contactId,
              endpointId: open.endpointId,
              ownerRef: { kind: "session", id: ctx.sessionId },
              openedBy: "resident",
              policy: {
                expiresAt: at + open.timeoutMs,
                maxOutbound: open.maxOutbound ?? 8,
                maxInbound: open.maxInbound ?? 32,
                onInboundCapBreach: "demote",
              },
            },
            newTraceId(),
            at,
          );
          return {
            op: "open" as const,
            id: record.id,
            contactId: record.contactId,
            expiresAt: record.policy.expiresAt,
            maxOutbound: record.policy.maxOutbound,
            maxInbound: record.policy.maxInbound,
          };
        } catch (error) {
          throw new ToolRefused("converse", error instanceof Error ? error.message : String(error));
        }
      }
      if (operation.op === "close") {
        try {
          const traceId = newTraceId();
          const close = operation;
          const outcome = conversations.close(close.conversationId, "owner", traceId);
          const revoked = conversations.closeLeases(
            close.conversationId,
            "conversation_revoked",
            traceId,
          );
          return {
            op: "close" as const,
            result:
              outcome.kind === "unchanged"
                ? {
                    kind: "unchanged" as const,
                    conversationId: close.conversationId,
                    closedBy: outcome.record.closedBy,
                  }
                : {
                    kind: "closed" as const,
                    conversationId: close.conversationId,
                    revoked,
                  },
          };
        } catch (error) {
          throw new ToolRefused("converse", error instanceof Error ? error.message : String(error));
        }
      }
      const lease = operation;
      const delegation = leases.getDelegation(lease.delegationId);
      if (delegation === undefined)
        throw new ToolRefused("converse", `delegation ${lease.delegationId} does not exist`);
      if (delegation.status !== "open")
        throw new ToolRefused("converse", `delegation ${lease.delegationId} is already settled`);
      try {
        const record = leases.issue(
          {
            id: `lease:${crypto.randomUUID()}`,
            conversationId: lease.conversationId,
            holderDelegationId: lease.delegationId,
            delegationDeadline: delegation.deadline,
            maxOutbound: lease.maxOutbound,
          },
          newTraceId(),
          Date.now(),
        );
        return {
          op: "lease" as const,
          id: record.id,
          holderDelegationId: record.holderDelegationId,
          contactId: record.contactId,
          conversationId: record.conversationId,
          maxOutbound: record.budget.maxOutbound,
          expiresAt: record.expiresAt,
        };
      } catch (error) {
        throw new ToolRefused("converse", error instanceof Error ? error.message : String(error));
      }
    },
    render: (_args, value) => {
      if (value.op === "open")
        return `conversation ${String(value.id)} open to ${String(value.contactId)} until ${String(value.expiresAt)} (outbound cap ${String(value.maxOutbound)}, inbound cap ${String(value.maxInbound)})`;
      if (value.op === "lease")
        return `lease ${String(value.id)} issued to delegation ${String(value.holderDelegationId)} for ${String(value.contactId)} in conversation ${String(value.conversationId)} (${String(value.maxOutbound)} sends, expires ${String(value.expiresAt)})`;
      return value.result.kind === "unchanged"
        ? `conversation ${value.result.conversationId} was already closed (${value.result.closedBy ?? "unknown"})`
        : `conversation ${value.result.conversationId} closed`;
    },
  });
}
