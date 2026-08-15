import type { RuntimeResource } from "@openomni/protocol";
import { Tool } from "@openomni/protocol";

function uniqueLabels(labels: readonly string[]): string[] {
  return [...new Set(labels)];
}

/** @internal Package-local helper for McpToolProvider only. */
export function mcpToolMetadata(
  serverName: string,
  spec: Tool.Spec,
): { readonly labels: string[]; readonly descriptor: RuntimeResource.Descriptor } {
  // Canonical labels first: the grammar parsers take the first match, so a
  // remote spec shipping its own `mcp.*` or `source:*` label must not win.
  const labels = uniqueLabels([
    `tool:${spec.name}`,
    Tool.sourceLabel("mcp"),
    Tool.mcpServerLabel(serverName),
    ...(spec.labels ?? []),
  ]);

  return {
    labels,
    descriptor: {
      id: `tool:mcp:${serverName}:${spec.name}`,
      kind: "tool",
      source: { type: "mcp", serverId: serverName, remoteName: spec.name },
      labels,
      capabilities: [],
      effects: [],
    },
  };
}

/** @internal Package-local helper for McpToolProvider only. */
export function createResultSummary(output: unknown): string {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output);
  const length = outputStr.length;
  return `success:text:${length}b`;
}
