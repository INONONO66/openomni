import type { LeaseStore } from "@openomni/ledger";
import type { Delegation } from "@openomni/protocol";
import { newTraceId } from "@openomni/telemetry";
import { z } from "zod";
import { defineTool, ToolRefused } from "../core/define";

export interface LeasePort {
  readonly issue: typeof LeaseStore.issue;
  readonly getDelegation: (delegationId: string) => Delegation.Record | undefined;
}
const Input = z.object({
  delegationId: z.string().min(1).describe("Open delegation that will hold the lease."),
  conversationId: z.string().min(1).describe("Open conversation whose budget is carved."),
  maxOutbound: z.number().int().positive().describe("How many outbound sends the lease may spend from the window."),
}).strict();
const Output = z.object({ id: z.string(), holderDelegationId: z.string(), contactId: z.string(), conversationId: z.string(), maxOutbound: z.number(), expiresAt: z.number() }).strict();
const LEASE_OPEN_TOOL_NAME = "lease_open";
function executeLeaseOpen(port: LeasePort, now: () => number = Date.now) {
  return async (input: z.output<typeof Input>): Promise<z.output<typeof Output>> => {
    const delegation = port.getDelegation(input.delegationId);
    if (delegation === undefined) throw new ToolRefused(LEASE_OPEN_TOOL_NAME, `delegation ${input.delegationId} does not exist`);
    if (delegation.status !== "open") throw new ToolRefused(LEASE_OPEN_TOOL_NAME, `delegation ${input.delegationId} is already settled`);
    try {
      const record = port.issue({ id: `lease:${crypto.randomUUID()}`, conversationId: input.conversationId, holderDelegationId: input.delegationId, delegationDeadline: delegation.deadline, maxOutbound: input.maxOutbound }, newTraceId(), now());
      return { id: record.id, holderDelegationId: record.holderDelegationId, contactId: record.contactId, conversationId: record.conversationId, maxOutbound: record.budget.maxOutbound, expiresAt: record.expiresAt };
    } catch (error) { throw new ToolRefused(LEASE_OPEN_TOOL_NAME, error instanceof Error ? error.message : String(error)); }
  };
}
export const leaseOpenTool = defineTool({
  name: LEASE_OPEN_TOOL_NAME, category: "mutation",
  description: "Carve a bounded send allocation from an open conversation for a live delegation. The holder may then message that contact directly; the lease dies with the delegation, the conversation, or its own budget.",
  input: Input, output: Output, safe: false, execution: { kind: "host" }, placement: "host",
  visibility: { model: ["resident"], cell: ["resident"] },
  bind: (ports) => ports.leases === undefined ? undefined : executeLeaseOpen(ports.leases),
  render: (_args, value) => `lease ${value.id} issued to delegation ${value.holderDelegationId} for ${value.contactId} in conversation ${value.conversationId} (${value.maxOutbound} sends, expires ${value.expiresAt})`,
});
