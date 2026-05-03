import { McpClient } from "@openomni/agent";
import type { McpServerConfig, Tool } from "@openomni/protocol";
import { Log } from "@openomni/session";
import type { NativeTool, ToolCategory, ToolProvider } from "@openomni/openomni";
import { McpPrefixGuardMiddleware } from "./mcp-prefix-guard";

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
      Log.warn("failed to connect to mcp server", {
        name: config.name,
        err: err instanceof Error ? err.message : String(err),
      });
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
            isReadOnly: false,
            isDestructive: false,
            isConcurrencySafe: false,
            source: "mcp",
            execute: (call) => client.callTool(call.tool, call.input, call.id),
          });
        }
      } catch (err) {
        Log.warn("failed to list tools from mcp server", {
          serverName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.cachedTools = tools;
  }

  async execute(call: Tool.Call): Promise<Tool.Result> {
    const guard = await McpPrefixGuardMiddleware.evaluatePreToolUse({
      call,
      tools: this.listTools(),
      isServerConnected: (serverName) =>
        this.clients.has(serverName) && this.connected.has(serverName),
    });
    const tool = guard.tool;
    if (guard.verdict.action !== "continue" || !tool) {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: guard.verdict.reason ?? `Unknown tool: ${call.tool}`,
        isError: true,
      };
    }

    return tool.execute({ ...call, tool: tool.spec.name });
  }

  get serverCount(): number {
    return this.connected.size;
  }
}
