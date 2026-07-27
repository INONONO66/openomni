import type { RuntimeResource, Tool, ToolSelection } from "@openomni/protocol";
import { resolveCategory, type NativeTool } from "@openomni/openomni";
import { createAllAgents } from "../agents";
import { RuntimeAgentDefinition } from "../agents/runtime-definition";
import type { CustomToolProvider } from "../tool/custom";
import type { McpToolProvider } from "../tool/mcp";

export interface RuntimeToolCatalogEntryV1 {
  readonly canonicalName: string;
  readonly exposedName: string;
  readonly source: Tool.Source;
  readonly category: ToolSelection.Category;
  readonly riskTier: Tool.RiskTier;
  readonly spec: Tool.Spec;
  readonly descriptor?: RuntimeResource.Descriptor;
  readonly mcpServer?: string;
}

export interface WorkerBootstrapV1 {
  readonly [key: string]: unknown;
  readonly configEpoch: string;
  readonly agents: readonly RuntimeAgentDefinition[];
  readonly toolCatalog: readonly RuntimeToolCatalogEntryV1[];
  readonly credentials?: never;
}

function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

export async function assembleBootstrap(
  mcpProvider: Pick<McpToolProvider, "listTools">,
  customProvider?: Pick<CustomToolProvider, "listTools">,
): Promise<WorkerBootstrapV1> {
  const agents = Object.freeze([...createAllAgents().values()].map(RuntimeAgentDefinition.create));

  const toolCatalog = Object.freeze([
    ...mcpProvider.listTools().map((tool) => createToolCatalogEntry(tool, "mcp")),
    ...(customProvider?.listTools().map((tool) => createToolCatalogEntry(tool, "server")) ?? []),
  ]);
  const epochInput = [
    ...agents.map((a) => a.name).sort(),
    ...toolCatalog.map((t) => t.canonicalName).sort(),
  ].join(",");
  const configEpoch = djb2Hash(epochInput);

  return Object.freeze({ configEpoch, agents, toolCatalog });
}

function createToolCatalogEntry(
  tool: NativeTool,
  source: RuntimeToolCatalogEntryV1["source"],
): RuntimeToolCatalogEntryV1 {
  const mcpServer = source === "mcp" ? getMcpServerName(tool.spec.name) : undefined;

  return Object.freeze({
    canonicalName: tool.spec.name,
    exposedName: tool.spec.name,
    source,
    category: resolveCategory(tool.spec.name, source, tool.category),
    riskTier: tool.riskTier,
    spec: tool.spec,
    ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
    ...(mcpServer !== undefined && { mcpServer }),
  });
}

function getMcpServerName(toolName: string): string | undefined {
  if (!toolName.includes(".")) return undefined;
  const [serverName] = toolName.split(".");
  return serverName;
}
