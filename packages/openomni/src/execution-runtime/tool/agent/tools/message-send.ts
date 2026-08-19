import { Gateway, Wait } from "@openomni/protocol";
import { z } from "zod";
import { defineTool, errorResult, fromError, successResult } from "../../define.js";
import type { NativeTool, ToolExecutionContext } from "../../types.js";

/**
 * `message.send` — the brain's as-me outbound trigger (#708, gateway stage 3;
 * docs/gateway-design.md §2b).
 *
 * The tool calls an INJECTED send port (`Gateway.SendInput → SendReceipt`):
 * the brain receives the port at composition and never imports the gateway
 * (openomni↔channels stays 0/0 — check-deps enforced). senderId is always the
 * Owner-owned resident persona actor; the model never chooses who it speaks
 * as. Authority is the gateway's: grants are Owner-written and default-empty,
 * so every send is denied `ungranted` until the Owner configures one — a
 * denial is a RESULT the agent sees and reasons about, never a thrown error.
 *
 * `expectReply` expands to a full waitSpec whose ownerRef is the CALLING
 * session (`{kind: "session", id: <executor-injected sessionId>}`) — the
 * engagement ownerRef arrives with #709.
 */

/** Default reply deadline for awaited sends: 24 hours. */
export const DEFAULT_EXPECT_REPLY_EXPIRES_IN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ALLOWED_ACTIONS: readonly Wait.AllowedAction[] = ["report_result"];
const DEFAULT_FOLLOW_UP_WINDOW_MS = 0;

export type MessageSendPort = (input: Gateway.SendInput) => Promise<Gateway.SendReceipt>;

export type MessageSendToolOptions = Readonly<{
  /** The gateway send kernel, injected by the composition root (apps/server). */
  send: MessageSendPort;
  /**
   * The Owner-owned resident persona actor (ActorRegistry identity) every
   * as-me send is attributed to. Unset → the tool fails closed with a typed
   * error result ("persona not configured"); it never throws into the run.
   */
  personaActorId?: string;
  /** Injected clock — messaging never reads the wall clock internally. */
  now?: () => number;
}>;

const ExpectReplySchema = z
  .object({
    allowedActions: z.array(Wait.AllowedAction).min(1).optional(),
    expiresInMs: z.number().int().positive().optional(),
    followUpWindow: z.number().int().nonnegative().optional(),
  })
  .strict();

const MessageSendInputSchema = z
  .object({
    target: z
      .object({
        actorId: z.string().min(1),
        endpointId: z.string().min(1).optional(),
      })
      .strict(),
    body: z.string().min(1),
    operation: Gateway.MessageOperation,
    expectReply: ExpectReplySchema.optional(),
    /** Executor-injected calling session (implicit input — never model-supplied). */
    sessionId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.operation === "fire_and_forget" && input.expectReply !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'expectReply requires operation "awaited" — fire_and_forget never opens a Wait',
        path: ["expectReply"],
      });
    }
  });

type MessageSendInput = z.infer<typeof MessageSendInputSchema>;

const inputSchema = {
  type: "object",
  properties: {
    target: {
      type: "object",
      properties: {
        actorId: { type: "string", description: "Registered actor to reach." },
        endpointId: {
          type: "string",
          description: "Endpoint pin — required when the actor is reachable at several endpoints.",
        },
      },
      required: ["actorId"],
      additionalProperties: false,
    },
    body: { type: "string", description: "Message text, already rendered in persona voice." },
    operation: {
      enum: ["fire_and_forget", "awaited"],
      description:
        '"awaited" opens a durable reply Wait owned by the calling session; "fire_and_forget" delivers without awaiting.',
    },
    expectReply: {
      type: "object",
      description:
        'Awaited-reply shaping (operation "awaited" only). Defaults: allowedActions ["report_result"], expiresInMs 86400000 (24h), followUpWindow 0.',
      properties: {
        allowedActions: {
          type: "array",
          items: {
            enum: ["report_result", "ask_clarification", "attach_artifact", "decline_task"],
          },
          minItems: 1,
        },
        expiresInMs: { type: "number", description: "Reply deadline from now (default 24h)." },
        followUpWindow: {
          type: "number",
          description: "ms after resolution during which follow-ups still correlate (default 0).",
        },
      },
      additionalProperties: false,
    },
    sessionId: { type: "string" },
  },
  required: ["target", "body", "operation"],
  additionalProperties: false,
};

/**
 * The receipt rendered honestly for the model: `sent` carries the messageId
 * (+ waitId/deadline when awaited); `denied` carries the typed code + reason.
 * Denials are results, not errors — the agent must see `ungranted` and reason
 * about it.
 */
function renderReceipt(receipt: Gateway.SendReceipt): Record<string, unknown> {
  if (receipt.kind === "denied") {
    return {
      kind: "denied",
      code: receipt.code,
      reason: receipt.reason,
      messageId: receipt.messageId,
      targetActorId: receipt.targetActorId,
    };
  }
  const base = {
    kind: "sent",
    operation: receipt.operation,
    messageId: receipt.messageId,
    target: receipt.target,
  };
  if (receipt.operation === "awaited") {
    return { ...base, waitId: receipt.wait.id, replyExpiresAt: receipt.wait.expiresAt };
  }
  return base;
}

function buildSendInput(
  input: MessageSendInput,
  personaActorId: string,
  traceId: string,
  sessionId: string | undefined,
  at: number,
): Gateway.SendInput | { error: string } {
  const base = {
    messageId: crypto.randomUUID(),
    traceId,
    senderId: personaActorId,
    target: input.target,
    operation: input.operation,
    body: input.body,
    at,
  };
  if (input.operation === "fire_and_forget") return Gateway.SendInput.parse(base);
  if (sessionId === undefined) {
    return {
      error:
        "awaited send requires the calling session context — the executor injects it; " +
        "message.send cannot be called outside a session run",
    };
  }
  return Gateway.SendInput.parse({
    ...base,
    waitSpec: {
      waitId: crypto.randomUUID(),
      // #709 will carry the engagement ownerRef; until then the calling
      // session owns the Wait.
      ownerRef: { kind: "session", id: sessionId },
      allowedActions: [...(input.expectReply?.allowedActions ?? DEFAULT_ALLOWED_ACTIONS)],
      expectedResponders: [input.target.actorId],
      resolutionPolicy: "first_reply",
      expiresAt: at + (input.expectReply?.expiresInMs ?? DEFAULT_EXPECT_REPLY_EXPIRES_IN_MS),
      followUpWindow: input.expectReply?.followUpWindow ?? DEFAULT_FOLLOW_UP_WINDOW_MS,
    },
  });
}

export function createMessageSendTool(options: MessageSendToolOptions): NativeTool {
  const now = options.now ?? Date.now;
  const tool = defineTool<MessageSendInput>({
    name: "message.send",
    description:
      "Send an outbound message AS the resident persona to an existing, registered actor " +
      "through the gateway send kernel. Every send is Owner-grant-gated: without an active " +
      "sender-target grant the receipt is a denial (code `ungranted`) — denials are normal " +
      'results to reason about, not execution errors. operation "awaited" opens a durable ' +
      "reply Wait owned by the calling session (expectReply defaults: allowedActions " +
      '["report_result"], expiresInMs 86400000 = 24h, followUpWindow 0); reply correlation ' +
      "resumes this session when the target answers.",
    inputSchema,
    source: "agent",
    riskTier: 2,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    implicitInputs: { sessionId: "sessionId" },
    async execute(call, context?: ToolExecutionContext) {
      const parsed = MessageSendInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errorResult(
          call,
          `Invalid input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      // A send belongs to the run that asked for it (the executor refuses
      // traceless calls; this refuses direct traceless invocation too).
      const traceId = context?.traceContext?.traceId;
      if (traceId === undefined || traceId.length === 0) {
        return errorResult(call, "message.send requires the run trace context");
      }
      // Fail closed, in-band: no persona means no as-me identity to send
      // under. A typed error result — never a throw that kills the run.
      if (options.personaActorId === undefined) {
        return errorResult(
          call,
          "persona not configured: message.send needs the Owner-owned resident persona actor " +
            "(server config `messaging.personaActorId`) — as-me sends fail closed",
        );
      }
      const sendInput = buildSendInput(
        parsed.data,
        options.personaActorId,
        traceId,
        parsed.data.sessionId,
        now(),
      );
      if ("error" in sendInput) return errorResult(call, sendInput.error);
      try {
        const receipt = await options.send(sendInput);
        return successResult(call, JSON.stringify(renderReceipt(receipt)));
      } catch (error) {
        return fromError(call, error);
      }
    },
  });
  // Delegation category: the depth gate strips delegation tools from child
  // agents (catalog step 4), so only the depth-0 resident can speak as-me —
  // workers ask the Resident instead of borrowing the persona.
  return { ...tool, category: "delegation" };
}
