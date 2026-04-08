import type { NativeTool } from "../../types";

export const notificationTool: NativeTool = {
  spec: {
    name: "notification.send",
    description: "Send a notification (not yet implemented)",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        channel: { type: "string" },
      },
      required: ["message"],
    },
  },
  riskTier: 0,
  execute(call) {
    return Promise.resolve({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: "[notification.send] not implemented yet",
    });
  },
};
