import type { NativeTool } from "../../types";

function createStub(name: string, description: string): NativeTool {
  return {
    spec: {
      name,
      description,
      inputSchema: { type: "object", properties: {} },
    },
    riskTier: 0,
    execute(call) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[${name}] not implemented yet`,
      });
    },
  };
}

export const stubTools: NativeTool[] = [
  createStub("messenger.send", "Send a message between agents"),
  createStub("ingress.submit", "Submit a task to the ingress engine"),
  createStub("plan.create", "Create an execution plan"),
  createStub("plan.list", "List existing execution plans"),
  createStub("approval.request", "Request human approval for a pending action"),
];
