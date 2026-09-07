import { defineTool, ToolRefused } from "@openomni/agent";
import { Gateway, LedgerSession } from "@openomni/protocol";
import { z } from "zod";

export interface MessagePort {
  ingest(
    sender: Gateway.IngestSender,
    message: Gateway.SendMessage | Gateway.IngressFacts,
  ): Promise<Gateway.IngestResult>;
}

const Id = z.string().min(1);

/** Model vocabulary (§3.5): one `contact` noun; the protocol keeps `Actor` internally. */
const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), id: Id }).strict(),
  z
    .object({
      kind: z.literal("new_session"),
      role: LedgerSession.Role,
      runner: Id,
      // The authenticated caller supplies the parent identity, not the model.
      parent: z.literal("me"),
    })
    .strict(),
  z.object({ kind: z.literal("contact"), id: Id }).strict(),
]);

export const SendMessageInput = z
  .object({
    to: Target,
    message: z.string(),
    kind: z
      .enum(["prompt", "interrupt", "resume"])
      .default("prompt")
      .describe("prompt is the default letter; interrupt and resume steer a running session."),
    reply_to: Id.optional(),
    deadline_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Milliseconds from now after which no reply counts as unknown."),
  })
  .strict();
export type SendMessageInput = z.output<typeof SendMessageInput>;

/** The tool's vocabulary folded onto the gateway's consumer surface. */
function toGatewaySend(input: SendMessageInput, now: number): Gateway.SendMessage {
  return {
    to: input.to.kind === "contact" ? { kind: "actor", actorId: input.to.id } : input.to,
    type: input.kind === "prompt" ? "message" : input.kind,
    content: input.message,
    ...(input.reply_to === undefined ? {} : { replyTo: input.reply_to }),
    ...(input.deadline_ms === undefined ? {} : { deadline: now + input.deadline_ms }),
  };
}

/** The catalog is static: without a composed gateway the tool exists and refuses. */
export function createSendMessageTool(port: MessagePort | undefined, now: () => number = Date.now) {
  return defineTool({
    name: "send_message",
    category: "authority",
    description:
      "Send one letter to a session, a new child session, or a contact. Returns a handle without waiting for a reply; the reply arrives in your inbox.",
    input: SendMessageInput,
    output: Gateway.SendMessageHandle,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    async execute(input, context) {
      if (port === undefined)
        throw new ToolRefused("send_message", "message gateway is not composed");
      const result = await port.ingest(
        { kind: "session", id: context.sessionId },
        toGatewaySend(input, now()),
      );
      if (result.status !== "executed") throw new ToolRefused("send_message", result.reasonCode);
      return result.handle;
    },
    render: (_input, result) => JSON.stringify(result),
  });
}
