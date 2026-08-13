import { McpClient } from "@openomni/agent";
import type { McpServerConfig, Tool } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type {
  NativeTool,
  ToolCategory,
  ToolExecutionContext,
  ToolProvider,
} from "@openomni/openomni";
import { executeMcpTool } from "./provider-execution";
import { refreshMcpTools } from "./provider-tool-listing";
import type { McpClientLike, McpToolProviderOptions } from "./provider-types";

export type { McpToolProviderOptions } from "./provider-types";

export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";
  readonly category: ToolCategory = "mcp";

  private clients = new Map<string, McpClientLike>();
  private connected = new Set<string>();
  private cachedTools: NativeTool[] | null = null;

  constructor(private readonly options: McpToolProviderOptions) {}

  async addServer(config: McpServerConfig): Promise<void> {
    const client =
      this.options.createClient?.(config) ??
      new McpClient(config, { traceId: this.options.traceId });
    try {
      await client.connect();
      this.clients.set(config.name, client);
      this.connected.add(config.name);
      this.cachedTools = null;
    } catch (err) {
      Bus.publish(Operational.Warn, {
        traceId: this.options.traceId,
        time: Date.now(),
        component: "server",
        msg: "failed to connect to mcp server",
        context: {
          name: config.name,
          err: err instanceof Error ? err.message : String(err),
        },
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
    const disconnects = [...this.clients.entries()].map(async ([clientName, client]) => {
      await client.disconnect().catch(() => undefined);
      this.connected.delete(clientName);
    });
    await Promise.all(disconnects);
    this.clients.clear();
    this.cachedTools = null;
  }

  listTools(): NativeTool[] {
    return this.cachedTools ?? [];
  }

  async refreshTools(): Promise<void> {
    this.cachedTools = await refreshMcpTools(this.clients, this.options.traceId);
  }

  async execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> {
    return executeMcpTool({
      call,
      context,
      tools: this.listTools(),
      isServerConnected: (serverName) =>
        this.clients.has(serverName) && this.connected.has(serverName),
    });
  }

  get serverCount(): number {
    return this.connected.size;
  }
}
