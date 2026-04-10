import type { McpToolProvider } from "../tool/mcp";
import type { ServerConfig } from "../config";

export async function connectMcpServers(
  config: ServerConfig,
  provider: McpToolProvider,
): Promise<void> {
  const servers = config.mcp.servers;
  if (servers.length === 0) return;

  for (const server of servers) {
    await provider.addServer(server);
  }

  await provider.refreshTools();
  console.log(`[mcp] connected ${provider.serverCount}/${servers.length} server(s)`);
}
