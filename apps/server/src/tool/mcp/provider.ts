import { McpClient } from "@openomni/agent";
import type { McpServerConfig, Tool } from "@openomni/protocol";
import { Mcp, PolicyDecision, PolicyEvent, ToolExecution } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type {
  NativeTool,
  ToolCategory,
  ToolExecutionContext,
  ToolProvider,
} from "@openomni/openomni";
import { McpPrefixGuardMiddleware } from "./mcp-prefix-guard";
import {
  MCP_TOOL_ACTION,
  buildActor,
  publishLifecycleApproved,
  publishLifecycleBlocked,
  publishLifecycleRequested,
  readSessionId,
  resolveLifecycleAudit,
  summarizeServerConfig,
} from "./provider-audit";
import { createResultSummary, mcpToolMetadata } from "./provider-metadata";
import type {
  McpClientLike,
  McpLifecycleAuditContext,
  McpToolProviderOptions,
} from "./provider-types";

export type { McpLifecycleAuditContext, McpToolProviderOptions } from "./provider-types";

function createAbortError(): Error {
  const error = new Error("MCP tool execution aborted");
  error.name = "AbortError";
  return error;
}

export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";
  readonly category: ToolCategory = "mcp";

  private clients = new Map<string, McpClientLike>();
  private connected = new Set<string>();
  private cachedTools: NativeTool[] | null = null;

  constructor(private readonly options: McpToolProviderOptions = {}) {}

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
    } catch (err) {
      if (audit) {
        publishLifecycleBlocked({
          audit,
          actionId,
          action: "mcp.server.connect",
          resource: config.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
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
    const tools: NativeTool[] = [];
    for (const [serverName, client] of this.clients) {
      try {
        const specs = await client.listTools();
        for (const spec of specs) {
          const metadata = mcpToolMetadata(serverName, spec);
          tools.push({
            spec: { ...spec, labels: metadata.labels },
            labels: metadata.labels,
            descriptor: metadata.descriptor,
            riskTier: 1,
            isReadOnly: false,
            isDestructive: false,
            isConcurrencySafe: false,
            source: "mcp",
            execute: (call, context) => {
              if (context?.signal?.aborted) return Promise.reject(createAbortError());
              return client.callTool(call.tool, call.input, call.id, context);
            },
          });
        }
      } catch (err) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "server",
          msg: "failed to list tools from mcp server",
          context: {
            serverName,
            err: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    this.cachedTools = tools;
  }

  async execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> {
    const guard = await McpPrefixGuardMiddleware.evaluatePreToolUse({
      call,
      tools: this.listTools(),
      isServerConnected: (serverName) =>
        this.clients.has(serverName) && this.connected.has(serverName),
    });
    const tool = guard.tool;
    if (PolicyDecision.isBlocking(guard.verdict) || !tool) {
      const result = {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: PolicyDecision.reason(guard.verdict, `Unknown tool: ${call.tool}`),
        isError: true,
      };
      const sessionId = readSessionId(call);
      if (sessionId) {
        Bus.publish(PolicyEvent.ActionBlocked, {
          traceId: crypto.randomUUID(),
          sessionId,
          time: Date.now(),
          actionId: crypto.randomUUID(),
          actor: buildActor(sessionId),
          action: MCP_TOOL_ACTION,
          resource: tool?.spec.name ?? call.tool,
          verdict: "deny" as const,
          reason: PolicyDecision.reason(guard.verdict, `Unknown tool: ${call.tool}`),
        });
      }
      return result;
    }

    const sessionId = readSessionId(call) ?? "";
    const actionId = crypto.randomUUID();
    const actor = buildActor(sessionId);

    Bus.publish(PolicyEvent.ActionRequested, {
      traceId: crypto.randomUUID(),
      sessionId,
      time: Date.now(),
      actionId,
      actor,
      action: MCP_TOOL_ACTION,
      resource: tool.spec.name,
      context: { input: call.input },
    });

    const startTime = Date.now();
    const result = await (context === undefined
      ? tool.execute({ ...call, tool: tool.spec.name })
      : tool.execute({ ...call, tool: tool.spec.name }, context));
    const durationMs = Date.now() - startTime;

    Bus.publish(ToolExecution.Completed, {
      traceId: crypto.randomUUID(),
      sessionId,
      time: Date.now(),
      actor,
      toolCallId: call.id,
      toolName: tool.spec.name,
      durationMs,
      isError: result.isError ?? false,
    });

    if (!result.isError) {
      const resultSummary = createResultSummary(result.output);
      const serverName = tool.spec.name.split(".")[0] ?? "unknown";

      Bus.publish(Mcp.ToolCompleted, {
        traceId: crypto.randomUUID(),
        serverName,
        toolName: tool.spec.name,
        toolCallId: call.id,
        durationMs,
        resultSummary,
        time: Date.now(),
      });
    }

    return result;
  }

  get serverCount(): number {
    return this.connected.size;
  }
}
