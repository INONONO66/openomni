import { Auth } from "@openomni/llm";
import { WorkerBootstrap } from "@openomni/protocol";
import { resolveCategory, type NativeTool } from "@openomni/openomni";
import { createAllAgents } from "../agents";
import type { CustomToolProvider } from "../tool/custom";
import type { McpToolProvider } from "../tool/mcp";

function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

export async function assembleBootstrap(
  mcpProvider: Pick<McpToolProvider, "listTools">,
  authEntries?: Awaited<ReturnType<typeof Auth.all>>,
  customProvider?: Pick<CustomToolProvider, "listTools">,
): Promise<WorkerBootstrap.Bootstrap> {
  // Sole server-to-worker agent egress boundary: protocol parsing projects the
  // worker wire contract and intentionally strips server-only prompt metadata.
  const agents = [...createAllAgents().values()].map((definition) =>
    WorkerBootstrap.AgentDefinition.parse(definition),
  );

  const toolCatalog = [
    ...mcpProvider.listTools().map((tool) => createToolCatalogEntry(tool, "mcp")),
    ...(customProvider?.listTools().map((tool) => createToolCatalogEntry(tool, "server")) ?? []),
  ];

  const resolvedAuthEntries = authEntries ?? (await Auth.all());
  const credentials: Record<string, string> = {};
  for (const [provider, entry] of Object.entries(resolvedAuthEntries)) {
    const prefix = provider.toUpperCase();
    if (entry.type === "api") {
      credentials[`${prefix}_API_KEY`] = entry.key;
    } else if (entry.type === "proxy") {
      credentials[`${prefix}_BASE_URL`] = entry.baseURL;
      if (entry.apiKey) credentials[`${prefix}_API_KEY`] = entry.apiKey;
    }
  }

  const epochInput = [
    ...agents.map((a) => a.name).sort(),
    ...toolCatalog.map((t) => t.canonicalName).sort(),
  ].join(",");
  const configEpoch = djb2Hash(epochInput);

  return { configEpoch, agents, toolCatalog, credentials };
}

function createToolCatalogEntry(
  tool: NativeTool,
  source: WorkerBootstrap.ToolCatalogEntry["source"],
): WorkerBootstrap.ToolCatalogEntry {
  const mcpServer =
    tool.descriptor?.source?.type === "mcp" ? tool.descriptor.source.serverId : undefined;

  return {
    canonicalName: tool.spec.name,
    exposedName: tool.spec.name,
    source,
    category: resolveCategory(tool.spec.name, source, tool.category),
    riskTier: tool.riskTier,
    spec: tool.spec,
    ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
    ...(mcpServer !== undefined && { mcpServer }),
  };
}
