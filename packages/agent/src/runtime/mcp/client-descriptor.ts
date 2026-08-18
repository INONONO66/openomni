import type { Policy } from "@openomni/protocol";
import { Tool } from "@openomni/protocol";

type McpToolSpec = Tool.Spec & {
  readonly descriptor: Policy.Resource.Descriptor;
};

function createMcpToolDescriptor(serverId: string, remoteName: string): Policy.Resource.Descriptor {
  return {
    id: `tool:mcp:${serverId}:${remoteName}`,
    kind: "tool",
    source: {
      type: "mcp",
      serverId,
      remoteName,
    },
    labels: [Tool.sourceLabel("mcp"), Tool.mcpServerLabel(serverId)],
    capabilities: ["network.write"],
    effects: ["external.write"],
  };
}

export function attachMcpToolDescriptor(
  spec: Tool.Spec,
  serverId: string,
  remoteName: string,
): McpToolSpec {
  const descriptor = createMcpToolDescriptor(serverId, remoteName);

  return {
    ...spec,
    labels: descriptor.labels,
    descriptor,
  };
}
