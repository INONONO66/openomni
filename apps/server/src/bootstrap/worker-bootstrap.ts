import { Auth } from "@openomni/llm";
import type { WorkerBootstrap } from "@openomni/protocol";
import { resolveCategory } from "@openomni/openomni";
import { createAllAgents } from "../agents";
import { RuntimeAgentDefinition } from "../agents/runtime-definition";
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
): Promise<WorkerBootstrap.Bootstrap> {
  const agents = [...createAllAgents().values()].map(RuntimeAgentDefinition.create);

  const toolCatalog = mcpProvider.listTools().map(
    (tool): WorkerBootstrap.RuntimeToolCatalogEntry => ({
      canonicalName: tool.spec.name,
      exposedName: tool.spec.name,
      source: "mcp",
      category: resolveCategory(tool.spec.name, "mcp", tool.category),
      riskTier: tool.riskTier,
      spec: tool.spec,
      ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
      mcpServer: tool.spec.name.includes(".") ? tool.spec.name.split(".")[0] : undefined,
    }),
  );

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
