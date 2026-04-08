import { McpClient } from "@openomni/agent/src/runtime/mcp";
import type { McpServerConfig } from "@openomni/agent/src/runtime/mcp";
import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider } from "../types";

export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";
  readonly category: ToolCategory = "mcp";

  private clients = new Map<string, McpClient>();
  private connected = new Set<string>();
  private cachedTools: NativeTool[] | null = null;

  async addServer(config: McpServerConfig): Promise<void> {
    const client = new McpClient(config);
    try {
      await client.connect();
      this.clients.set(config.name, client);
      this.connected.add(config.name);
      this.cachedTools = null;
    } catch (err) {
      console.warn(
        `[mcp] Failed to connect to ${config.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;
    await client.disconnect().catch(() => undefined);
    this.clients.delete(name);
    this.connected.delete(name);
    this.cachedTools = null;
  }

  async disconnectAll(): Promise<void> {
    const disconnects = [...this.clients.entries()].map(async ([name, client]) => {
      await client.disconnect().catch(() => undefined);
      this.connected.delete(name);
    });
    await Promise.all(disconnects);
    this.clients.clear();
    this.cachedTools = null;
  }

  listTools(): NativeTool[] {
    return this.cachedTools ?? [];
  }

  async refreshTools(): Promise<void> {
    const tools: NativeTool[] = [];
    for (const [serverName, client] of this.clients) {
      try {
        const specs = await client.listTools();
        for (const spec of specs) {
          tools.push({
            spec,
            riskTier: 1,
            execute: (call) => client.callTool(call.tool, call.input, call.id),
          });
        }
      } catch (err) {
        console.warn(
          `[mcp] Failed to list tools from ${serverName}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.cachedTools = tools;
  }

  execute(call: Tool.Call): Promise<Tool.Result> {
    const tool = this.listTools().find(
      (entry) => entry.spec.name === call.tool || entry.spec.name === call.tool.replace(/_/g, "."),
    );
    if (!tool) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `Unknown tool: ${call.tool}`,
        isError: true,
      });
    }

    const dotIndex = tool.spec.name.indexOf(".");
    if (dotIndex === -1) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `MCP tool name must be prefixed with server name: ${tool.spec.name}`,
        isError: true,
      });
    }

    const serverName = tool.spec.name.slice(0, dotIndex);
    const client = this.clients.get(serverName);
    if (!client) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `MCP server not found: ${serverName}`,
        isError: true,
      });
    }

    return tool.execute({ ...call, tool: tool.spec.name });
  }

  get serverCount(): number {
    return this.connected.size;
  }
}
