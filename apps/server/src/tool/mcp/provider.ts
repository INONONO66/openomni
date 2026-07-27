import { McpClient } from "@openomni/agent";
import type { McpServerConfig, Tool } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type {
  NativeTool,
  ToolCategory,
  ToolEffectLedgerPortV1,
  ToolExecutionContext,
  ToolProvider,
  WorkspaceIdentity,
} from "@openomni/openomni";
import {
  publishLifecycleApproved,
  publishLifecycleBlocked,
  publishLifecycleRequested,
  resolveLifecycleAudit,
  summarizeServerConfig,
} from "./provider-audit";
import { executeMcpTool } from "./provider-execution";
import { refreshMcpTools } from "./provider-tool-listing";
import type {
  McpClientLike,
  McpLifecycleAuditContext,
  McpToolProviderOptions as McpClientOptions,
} from "./provider-types";

export type { McpLifecycleAuditContext } from "./provider-types";

export interface McpToolProviderOptions extends McpClientOptions {
  readonly effects: ToolEffectLedgerPortV1;
  readonly workspaceIdentity: WorkspaceIdentity;
}

export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";
  readonly category: ToolCategory = "mcp";

  private clients = new Map<string, McpClientLike>();
  private connected = new Set<string>();
  private cachedTools: NativeTool[] | null = null;

  constructor(private readonly options: McpToolProviderOptions) {}

  async addServer(config: McpServerConfig, context?: McpLifecycleAuditContext): Promise<void> {
    const audit = resolveLifecycleAudit(context);
    const actionId = crypto.randomUUID();

    if (audit) {
      publishLifecycleRequested({
        audit,
        actionId,
        action: "mcp.server.connect",
        resource: config.name,
        context: summarizeServerConfig(config),
      });
    }

    const client = this.options.createClient?.(config) ?? new McpClient(config);
    try {
      await client.connect();
      this.clients.set(config.name, client);
      this.connected.add(config.name);
      this.cachedTools = null;

      if (audit) {
        publishLifecycleApproved({
          audit,
          actionId,
          action: "mcp.server.connect",
          resource: config.name,
          reason: "MCP server connected",
        });
      }
    } catch {
      if (audit) {
        publishLifecycleBlocked({
          audit,
          actionId,
          action: "mcp.server.connect",
          resource: config.name,
          reason: "MCP server connection failed",
        });
      }
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "failed to connect to mcp server",
        context: {
          name: config.name,
          connectionFailed: true,
        },
      });
    }
  }

  async removeServer(name: string, context?: McpLifecycleAuditContext): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;
    const audit = resolveLifecycleAudit(context);
    const actionId = crypto.randomUUID();

    if (audit) {
      publishLifecycleRequested({
        audit,
        actionId,
        action: "mcp.server.disconnect",
        resource: name,
        context: { serverName: name },
      });
    }

    await client.disconnect().catch(() => undefined);
    this.clients.delete(name);
    this.connected.delete(name);
    this.cachedTools = null;

    if (audit) {
      publishLifecycleApproved({
        audit,
        actionId,
        action: "mcp.server.disconnect",
        resource: name,
        reason: "MCP server disconnected",
      });
    }
  }

  async disconnectAll(context?: McpLifecycleAuditContext): Promise<void> {
    const serverNames = [...this.clients.keys()];
    const audit = resolveLifecycleAudit(context);
    const actionId = crypto.randomUUID();

    if (audit) {
      publishLifecycleRequested({
        audit,
        actionId,
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        context: { serverNames },
      });
    }

    const disconnects = [...this.clients.entries()].map(async ([clientName, client]) => {
      await client.disconnect().catch(() => undefined);
      this.connected.delete(clientName);
    });
    await Promise.all(disconnects);
    this.clients.clear();
    this.cachedTools = null;

    if (audit) {
      publishLifecycleApproved({
        audit,
        actionId,
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        reason: "MCP servers disconnected",
      });
    }
  }

  listTools(): NativeTool[] {
    return this.cachedTools ?? [];
  }

  async refreshTools(): Promise<void> {
    this.cachedTools = await refreshMcpTools(this.clients);
  }

  async execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> {
    return executeMcpTool({
      call,
      context,
      tools: this.listTools(),
      isServerConnected: (serverName) =>
        this.clients.has(serverName) && this.connected.has(serverName),
      effects: this.options.effects,
      workspaceIdentity: this.options.workspaceIdentity,
    });
  }

  get serverCount(): number {
    return this.connected.size;
  }
}
