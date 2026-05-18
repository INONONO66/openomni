import { McpClient } from "@openomni/agent";
import type { McpServerConfig, RuntimeResource, Tool } from "@openomni/protocol";
import { Mcp, PolicyDecision, PolicyEvent, ToolExecution } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";
import type {
  NativeTool,
  ToolCategory,
  ToolExecutionContext,
  ToolProvider,
} from "@openomni/openomni";
import { McpPrefixGuardMiddleware } from "./mcp-prefix-guard";

const MCP_TOOL_ACTION = "mcp.tool.call";
function createAbortError(): Error {
  const error = new Error("MCP tool execution aborted");
  error.name = "AbortError";
  return error;
}

interface McpClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<Tool.Spec[]>;
  callTool(
    toolName: string,
    input: Record<string, unknown>,
    callId?: string,
    context?: ToolExecutionContext,
  ): Promise<Tool.Result>;
}

function uniqueLabels(labels: readonly string[]): string[] {
  return [...new Set(labels)];
}

function mcpToolMetadata(
  serverName: string,
  spec: Tool.Spec,
): { readonly labels: string[]; readonly descriptor: RuntimeResource.Descriptor } {
  const labels = uniqueLabels([
    ...(spec.labels ?? []),
    `tool:${spec.name}`,
    "source.mcp",
    `mcp.${serverName}`,
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

export interface McpToolProviderOptions {
  readonly createClient?: (config: McpServerConfig) => McpClientLike;
}

export interface McpLifecycleAuditContext {
  readonly audit?: {
    readonly sessionId?: string;
  };
  readonly actor?: Record<string, unknown>;
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
      Bus.publish(PolicyEvent.ActionRequested, {
        ...lifecycleBase(audit),
        actionId,
        actor: buildActor(audit.sessionId, audit.actor),
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
        Bus.publish(PolicyEvent.ActionApproved, {
          ...lifecycleBase(audit),
          actionId,
          actor: buildActor(audit.sessionId, audit.actor),
          action: "mcp.server.connect",
          resource: config.name,
          verdict: "allow" as const,
          reason: "MCP server connected",
        });
      }
    } catch (err) {
      if (audit) {
        Bus.publish(PolicyEvent.ActionBlocked, {
          ...lifecycleBase(audit),
          actionId,
          actor: buildActor(audit.sessionId, audit.actor),
          action: "mcp.server.connect",
          resource: config.name,
          verdict: "deny" as const,
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
      Bus.publish(PolicyEvent.ActionRequested, {
        ...lifecycleBase(audit),
        actionId,
        actor: buildActor(audit.sessionId, audit.actor),
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
      Bus.publish(PolicyEvent.ActionApproved, {
        ...lifecycleBase(audit),
        actionId,
        actor: buildActor(audit.sessionId, audit.actor),
        action: "mcp.server.disconnect",
        resource: name,
        verdict: "allow" as const,
        reason: "MCP server disconnected",
      });
    }
  }

  async disconnectAll(context?: McpLifecycleAuditContext): Promise<void> {
    const serverNames = [...this.clients.keys()];
    const audit = resolveLifecycleAudit(context);
    const actionId = crypto.randomUUID();

    if (audit) {
      Bus.publish(PolicyEvent.ActionRequested, {
        ...lifecycleBase(audit),
        actionId,
        actor: buildActor(audit.sessionId, audit.actor),
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
      Bus.publish(PolicyEvent.ActionApproved, {
        ...lifecycleBase(audit),
        actionId,
        actor: buildActor(audit.sessionId, audit.actor),
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        verdict: "allow" as const,
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

type ResolvedLifecycleAudit = {
  readonly sessionId: string;
  readonly actor?: Record<string, unknown>;
};

function resolveLifecycleAudit(
  context: McpLifecycleAuditContext | undefined,
): ResolvedLifecycleAudit | undefined {
  const sessionId = context?.audit?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    const fallbackSession = latestSession();
    if (!fallbackSession) return undefined;
    return {
      sessionId: fallbackSession.id,
      ...(context?.actor !== undefined && { actor: context.actor }),
    };
  }
  return {
    sessionId,
    ...(context?.actor !== undefined && { actor: context.actor }),
  };
}

function latestSession(): { readonly id: string } | undefined {
  return Storage.get()
    .session.list()
    .sort((left, right) => right.time.updated - left.time.updated)[0];
}

function summarizeServerConfig(config: McpServerConfig): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    serverName: config.name,
    transport: config.transport,
    ...(config.timeout !== undefined && { timeout: config.timeout }),
    ...(config.retries !== undefined && { retries: config.retries }),
    ...(config.headers !== undefined && { headerNames: Object.keys(config.headers).sort() }),
  };

  if (config.transport === "stdio") {
    return {
      ...summary,
      command: config.command,
      ...(config.args !== undefined && { argsCount: config.args.length }),
    };
  }

  return { ...summary, url: config.url };
}

function lifecycleBase(audit: ResolvedLifecycleAudit) {
  return {
    traceId: crypto.randomUUID(),
    sessionId: audit.sessionId,
    time: Date.now(),
  };
}

function readSessionId(call: Tool.Call): string | undefined {
  const sessionId = call.input.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function buildActor(
  sessionId: string | undefined,
  actor: Record<string, unknown> | undefined = undefined,
): Record<string, unknown> {
  return {
    ...(actor ?? {}),
    kind: "mcp_provider",
    ...(sessionId !== undefined && { sessionId }),
  };
}

function createResultSummary(output: unknown): string {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output);
  const length = outputStr.length;
  return `success:text:${length}b`;
}
