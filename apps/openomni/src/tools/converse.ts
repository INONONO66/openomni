import type { ConversationStore } from "@openomni/ledger";
import { newTraceId, type Tool } from "@openomni/protocol";
import { z } from "zod";
import type { DelegationOrigin } from "../delegation/admission";

/**
 * Resident-facing Conversation tools (#P1, docs/conversation-and-message-io.md
 * §3.4): the Resident opens a bounded reply window to a contact it already
 * has a live route to (a channel grant is the perimeter's proof of that) and
 * settles windows idempotently. The store is the one enforcement layer for
 * window semantics; these executors are thin typed boundaries.
 */

export interface ConversePort {
  readonly open: typeof ConversationStore.open;
  readonly get: typeof ConversationStore.get;
  readonly close: typeof ConversationStore.close;
}

const OPEN_INPUT = z
  .object({
    contactId: z.string().min(1).describe("Registered actor the window reaches."),
    endpointId: z.string().min(1).describe("Allocated endpoint of that actor the window is pinned to."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe("How long the window stays open from now."),
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
      .describe("Inbound message cap before the treatment demotes to evidence_only (default 32)."),
  })
  .strict();

const CLOSE_INPUT = z
  .object({
    conversationId: z.string().min(1).describe("Window to settle."),
  })
  .strict();

const OPEN_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["contactId", "endpointId", "timeoutMs"],
  properties: {
    contactId: { type: "string", minLength: 1 },
    endpointId: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", exclusiveMinimum: 0 },
    maxOutbound: { type: "integer", exclusiveMinimum: 0 },
    maxInbound: { type: "integer", exclusiveMinimum: 0 },
  },
};

const CLOSE_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["conversationId"],
  properties: {
    conversationId: { type: "string", minLength: 1 },
  },
};

export function converseOpenToolSpec(): Tool.Spec {
  return {
    name: "converse_open",
    description:
      "Open a bounded reply window to a known contact. While it is open, the contact's inbound reaches this session directly and sends to the contact ride the window instead of a grant. The window closes on its deadline, its caps, or converse_close.",
    inputSchema: OPEN_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function converseCloseToolSpec(): Tool.Spec {
  return {
    name: "converse_close",
    description:
      "Settle an open reply window by id. Closing an already-closed window returns its existing settlement.",
    inputSchema: CLOSE_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function converseOpenToolExecutor(
  port: ConversePort,
  origin: DelegationOrigin,
  now: () => number = Date.now,
) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = OPEN_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `converse_open refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const input = parsed.data;
    const at = now();
    try {
      const record = port.open(
        {
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
        },
        // The tool call IS the trace origin (D11): no inbound trace reaches
        // this surface, so the window's events file under a fresh id.
        newTraceId(),
        at,
      );
      return `conversation ${record.id} open to ${record.contactId} until ${record.policy.expiresAt} (outbound cap ${record.policy.maxOutbound}, inbound cap ${record.policy.maxInbound})`;
    } catch (error) {
      return `converse_open refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

export function converseCloseToolExecutor(port: ConversePort) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = CLOSE_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `converse_close refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const conversationId = parsed.data.conversationId;
    try {
      const outcome = port.close(conversationId, "owner", newTraceId());
      if (outcome.kind === "unchanged") {
        return `conversation ${conversationId} was already closed (${outcome.record.closedBy ?? "unknown"})`;
      }
      return `conversation ${conversationId} closed`;
    } catch (error) {
      return `converse_close refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}
