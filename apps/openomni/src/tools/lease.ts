import { newTraceId } from "@openomni/telemetry";
import type { LeaseStore } from "@openomni/ledger";
import type { Delegation, Tool } from "@openomni/protocol";
import { z } from "zod";

/**
 * Resident-facing lease tool (#P2, docs/conversation-and-message-io.md §3.5):
 * the Resident carves a bounded slice of an open conversation's outbound
 * budget for one of its live delegations. The store's issue fold is the one
 * enforcement layer for the carve bound; this executor is a thin typed
 * boundary that resolves the delegation's deadline.
 */

export interface LeasePort {
  readonly issue: typeof LeaseStore.issue;
  readonly getDelegation: (delegationId: string) => Delegation.Record | undefined;
}

const OPEN_INPUT = z
  .object({
    delegationId: z.string().min(1).describe("Open delegation that will hold the lease."),
    conversationId: z.string().min(1).describe("Open conversation whose budget is carved."),
    maxOutbound: z
      .number()
      .int()
      .positive()
      .describe("How many outbound sends the lease may spend from the window."),
  })
  .strict();

const OPEN_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["delegationId", "conversationId", "maxOutbound"],
  properties: {
    delegationId: { type: "string", minLength: 1 },
    conversationId: { type: "string", minLength: 1 },
    maxOutbound: { type: "integer", exclusiveMinimum: 0 },
  },
};

export function leaseOpenToolSpec(): Tool.Spec {
  return {
    name: "lease_open",
    description:
      "Carve a bounded send allocation from an open conversation for a live delegation. The holder may then message that contact directly; the lease dies with the delegation, the conversation, or its own budget.",
    inputSchema: OPEN_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function leaseOpenToolExecutor(port: LeasePort, now: () => number = Date.now) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = OPEN_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `lease_open refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const input = parsed.data;
    const delegation = port.getDelegation(input.delegationId);
    if (delegation === undefined) {
      return `lease_open refused: delegation ${input.delegationId} does not exist`;
    }
    if (delegation.status !== "open") {
      return `lease_open refused: delegation ${input.delegationId} is already settled`;
    }
    try {
      const record = port.issue(
        {
          id: `lease:${crypto.randomUUID()}`,
          conversationId: input.conversationId,
          holderDelegationId: input.delegationId,
          delegationDeadline: delegation.deadline,
          maxOutbound: input.maxOutbound,
        },
        // The tool call IS the trace origin (D11).
        newTraceId(),
        now(),
      );
      return `lease ${record.id} issued to delegation ${record.holderDelegationId} for ${record.contactId} in conversation ${record.conversationId} (${record.budget.maxOutbound} sends, expires ${record.expiresAt})`;
    } catch (error) {
      return `lease_open refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}
