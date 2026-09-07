import { defineTool, ToolRefused } from "@openomni/agent";
import { Gateway } from "@openomni/protocol";

export interface MessagePort {
  ingest(
    sender: Gateway.IngestSender,
    message: Gateway.SendMessage | Gateway.IngressFacts,
  ): Promise<Gateway.IngestResult>;
}

export function createSendMessageTool(port: MessagePort) {
  return defineTool({
    name: "sendMessage",
    category: "authority",
    description:
      "Send a message, interrupt, or resume to a session; create a child session; or contact an actor. Returns a handle without waiting for a reply.",
    input: Gateway.SendMessage,
    output: Gateway.SendMessageHandle,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    async execute(input, context) {
      const result = await port.ingest({ kind: "session", id: context.sessionId }, input);
      if (result.status !== "executed") throw new ToolRefused("sendMessage", result.reasonCode);
      return result.handle;
    },
    render: (_input, result) => JSON.stringify(result),
  });
}
