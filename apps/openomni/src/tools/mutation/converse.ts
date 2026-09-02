import type { ConversationStore, LeaseStore } from "@openomni/ledger";
import { newTraceId } from "@openomni/telemetry";
import { z } from "zod";
import type { DelegationOrigin } from "../../delegation/admission";
import { defineTool, ToolRefused } from "../core/define";

export interface ConversePort {
  readonly open: typeof ConversationStore.open;
  readonly get: typeof ConversationStore.get;
  readonly close: typeof ConversationStore.close;
  readonly closeLeases: typeof LeaseStore.closeByConversation;
}

const OpenInput = z.object({
  contactId: z.string().min(1).describe("Registered actor the window reaches."),
  endpointId: z.string().min(1).describe("Allocated endpoint of that actor the window is pinned to."),
  timeoutMs: z.number().int().positive().describe("How long the window stays open from now."),
  maxOutbound: z.number().int().positive().optional().describe("Outbound message cap inside the window (default 8)."),
  maxInbound: z.number().int().positive().optional().describe("Inbound message cap before the treatment demotes to evidence_only (default 32)."),
}).strict();
const CloseInput = z.object({ conversationId: z.string().min(1).describe("Window to settle.") }).strict();

const OpenOutput = z.object({
  id: z.string(), contactId: z.string(), expiresAt: z.number(), maxOutbound: z.number(), maxInbound: z.number(),
}).strict();
const CloseOutput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unchanged"), conversationId: z.string(), closedBy: z.string().nullable().optional() }).strict(),
  z.object({ kind: z.literal("closed"), conversationId: z.string(), revoked: z.number().int().nonnegative() }).strict(),
]);

function executeConverseOpen(port: ConversePort, origin: DelegationOrigin, now: () => number = Date.now) {
  return async (input: z.output<typeof OpenInput>): Promise<z.output<typeof OpenOutput>> => {
    const at = now();
    try {
      const record = port.open({
        id: `conv:${origin.sessionId}:${crypto.randomUUID()}`,
        contactId: input.contactId,
        endpointId: input.endpointId,
        ownerRef: { kind: "session", id: origin.sessionId },
        openedBy: "resident",
        policy: {
          expiresAt: at + input.timeoutMs,
          maxOutbound: input.maxOutbound ?? 8,
          maxInbound: input.maxInbound ?? 32,
          onInboundCapBreach: "demote",
        },
      }, newTraceId(), at);
      return { id: record.id, contactId: record.contactId, expiresAt: record.policy.expiresAt, maxOutbound: record.policy.maxOutbound, maxInbound: record.policy.maxInbound };
    } catch (error) {
      throw new ToolRefused("converse_open", error instanceof Error ? error.message : String(error));
    }
  };
}

function executeConverseClose(port: ConversePort) {
  return async ({ conversationId }: z.output<typeof CloseInput>): Promise<z.output<typeof CloseOutput>> => {
    try {
      const traceId = newTraceId();
      const outcome = port.close(conversationId, "owner", traceId);
      const revoked = port.closeLeases(conversationId, "conversation_revoked", traceId);
      return outcome.kind === "unchanged"
        ? { kind: "unchanged", conversationId, closedBy: outcome.record.closedBy }
        : { kind: "closed", conversationId, revoked };
    } catch (error) {
      throw new ToolRefused("converse_close", error instanceof Error ? error.message : String(error));
    }
  };
}

export const converseOpenTool = defineTool({
  name: "converse_open", category: "mutation",
  description: "Open a bounded reply window to a known contact. While it is open, the contact's inbound reaches this session directly and sends to the contact ride the window instead of a grant. The window closes on its deadline, its caps, or converse_close.",
  input: OpenInput, output: OpenOutput, safe: false, execution: { kind: "host" }, placement: "host",
  visibility: { model: ["resident"], cell: ["resident"] },
  bind: (ports, origin) => ports.conversations === undefined ? undefined : executeConverseOpen(ports.conversations, origin),
  render: (_args, value) => `conversation ${value.id} open to ${value.contactId} until ${value.expiresAt} (outbound cap ${value.maxOutbound}, inbound cap ${value.maxInbound})`,
});

export const converseCloseTool = defineTool({
  name: "converse_close", category: "mutation",
  description: "Settle an open reply window by id. Closing an already-closed window returns its existing settlement.",
  input: CloseInput, output: CloseOutput, safe: false, execution: { kind: "host" }, placement: "host",
  visibility: { model: ["resident"], cell: ["resident"] },
  bind: (ports) => ports.conversations === undefined ? undefined : executeConverseClose(ports.conversations),
  render: (_args, value) => value.kind === "unchanged"
    ? `conversation ${value.conversationId} was already closed (${value.closedBy ?? "unknown"})`
    : value.revoked === 0 ? `conversation ${value.conversationId} closed` : `conversation ${value.conversationId} closed (${value.revoked} live lease${value.revoked === 1 ? "" : "s"} revoked)`,
});

export function converseOpenToolExecutor(port: ConversePort, origin: DelegationOrigin, now: () => number = Date.now) { return async (raw: unknown): Promise<string> => { try { const args = OpenInput.parse(raw); return converseOpenTool.render(args, await executeConverseOpen(port, origin, now)(args)); } catch (error) { return error instanceof ToolRefused ? error.message : `converse_open refused: ${error instanceof Error ? error.message : String(error)}`; } }; }
export function converseCloseToolExecutor(port: ConversePort) { return async (raw: unknown): Promise<string> => { try { const args = CloseInput.parse(raw); return converseCloseTool.render(args, await executeConverseClose(port)(args)); } catch (error) { return error instanceof ToolRefused ? error.message : `converse_close refused: ${error instanceof Error ? error.message : String(error)}`; } }; }
