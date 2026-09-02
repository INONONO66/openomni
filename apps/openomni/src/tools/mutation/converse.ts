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
const OpenArgs = z
  .object({
    contactId: z.string().min(1),
    endpointId: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    maxOutbound: z.number().int().positive().optional(),
    maxInbound: z.number().int().positive().optional(),
  })
  .strict();
const CloseArgs = z.object({ conversationId: z.string().min(1) }).strict();
const LeaseArgs = z
  .object({
    delegationId: z.string().min(1),
    conversationId: z.string().min(1),
    maxOutbound: z.number().int().positive(),
  })
  .strict();
const Input = z
  .object({
    op: z.union([z.literal("open"), z.literal("close"), z.literal("lease")]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const schema = value.op === "open" ? OpenArgs : value.op === "close" ? CloseArgs : LeaseArgs;
    const parsed = schema.safeParse(value.args);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue, path: ["args", ...issue.path] });
  });
const Output = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null,
);

export function createConverseTool(conversations: ConversePort, leases: LeasePort) {
  return defineTool({
    name: "converse",
    category: "mutation",
    description:
      "Open or close a bounded conversation window, or carve a delegation lease from one. Use op=open|close|lease.",
    input: Input,
    output: Output,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async (input, ctx) => {
      const args = input.args as Record<string, unknown>;
      if (input.op === "open") {
        const open = args as z.output<typeof OpenArgs>;
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
            op: "open",
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
      if (input.op === "close") {
        try {
          const traceId = newTraceId();
          const close = args as z.output<typeof CloseArgs>;
          const outcome = conversations.close(close.conversationId, "owner", traceId);
          const revoked = conversations.closeLeases(
            close.conversationId,
            "conversation_revoked",
            traceId,
          );
          return outcome.kind === "unchanged"
            ? {
                op: "close",
                kind: "unchanged",
                conversationId: close.conversationId,
                closedBy: outcome.record.closedBy,
              }
            : { op: "close", kind: "closed", conversationId: close.conversationId, revoked };
        } catch (error) {
          throw new ToolRefused("converse", error instanceof Error ? error.message : String(error));
        }
      }
      const lease = args as z.output<typeof LeaseArgs>;
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
          op: "lease",
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
    render: (args, value) => {
      if (args.op === "open")
        return `conversation ${String(value.id)} open to ${String(value.contactId)} until ${String(value.expiresAt)} (outbound cap ${String(value.maxOutbound)}, inbound cap ${String(value.maxInbound)})`;
      if (args.op === "lease")
        return `lease ${String(value.id)} issued to delegation ${String(value.holderDelegationId)} for ${String(value.contactId)} in conversation ${String(value.conversationId)} (${String(value.maxOutbound)} sends, expires ${String(value.expiresAt)})`;
      return value.kind === "unchanged"
        ? `conversation ${String(value.conversationId)} was already closed (${String(value.closedBy ?? "unknown")})`
        : `conversation ${String(value.conversationId)} closed`;
    },
  });
}
