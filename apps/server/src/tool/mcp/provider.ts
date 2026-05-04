import { McpClient } from "@openomni/agent";
import type { ExecutionEvent, McpServerConfig, Tool } from "@openomni/protocol";
import { Mcp } from "@openomni/protocol";
import { Bus, EventLog, Log, Storage } from "@openomni/session";
import type { NativeTool, ToolCategory, ToolProvider } from "@openomni/openomni";
import { McpPrefixGuardMiddleware } from "./mcp-prefix-guard";

const MCP_TOOL_ACTION = "mcp.tool.call";
const MCP_LEDGER_VISIBILITY = "internal";

interface McpClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<Tool.Spec[]>;
  callTool(toolName: string, input: Record<string, unknown>, callId?: string): Promise<Tool.Result>;
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
  private appendLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: McpToolProviderOptions = {}) {}

  async addServer(config: McpServerConfig, context?: McpLifecycleAuditContext): Promise<void> {
    const audit = resolveLifecycleAudit(context);
    const requested = await this.appendLifecycleEvent(
      audit,
      "action_requested",
      `lifecycle.connect.${config.name}`,
      (base): ExecutionEvent.ActionRequested => ({
        type: "action_requested",
        actor: buildActor(audit?.sessionId, audit?.actor),
        action: "mcp.server.connect",
        resource: config.name,
        input: summarizeServerConfig(config),
        ...base,
      }),
      { beforeSideEffect: true },
    );

    const client = this.options.createClient?.(config) ?? new McpClient(config);
    try {
      await client.connect();
      this.clients.set(config.name, client);
      this.connected.add(config.name);
      this.cachedTools = null;
      await this.appendLifecycleEvent(
        audit,
        "action_approved",
        `lifecycle.connect.${config.name}`,
        (base): ExecutionEvent.ActionApproved => ({
          type: "action_approved",
          policyId: "mcp.lifecycle-audit",
          actor: buildActor(audit?.sessionId, audit?.actor),
          action: "mcp.server.connect",
          resource: config.name,
          verdict: "continue",
          reason: "MCP server connected",
          ...base,
        }),
        { beforeSideEffect: false, parentActionId: requested?.actionId },
      );
    } catch (err) {
      await this.appendLifecycleEvent(
        audit,
        "action_blocked",
        `lifecycle.connect.${config.name}`,
        (base): ExecutionEvent.ActionBlocked => ({
          type: "action_blocked",
          policyId: "mcp.lifecycle-audit",
          actor: buildActor(audit?.sessionId, audit?.actor),
          action: "mcp.server.connect",
          resource: config.name,
          verdict: "abort",
          reason: err instanceof Error ? err.message : String(err),
          ...base,
        }),
        { beforeSideEffect: false, parentActionId: requested?.actionId },
      );
      Log.warn("failed to connect to mcp server", {
        name: config.name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async removeServer(name: string, context?: McpLifecycleAuditContext): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;
    const audit = resolveLifecycleAudit(context);
    const requested = await this.appendLifecycleEvent(
      audit,
      "action_requested",
      `lifecycle.disconnect.${name}`,
      (base): ExecutionEvent.ActionRequested => ({
        type: "action_requested",
        actor: buildActor(audit?.sessionId, audit?.actor),
        action: "mcp.server.disconnect",
        resource: name,
        input: { serverName: name },
        ...base,
      }),
      { beforeSideEffect: true },
    );
    await client.disconnect().catch(() => undefined);
    this.clients.delete(name);
    this.connected.delete(name);
    this.cachedTools = null;
    await this.appendLifecycleEvent(
      audit,
      "action_approved",
      `lifecycle.disconnect.${name}`,
      (base): ExecutionEvent.ActionApproved => ({
        type: "action_approved",
        policyId: "mcp.lifecycle-audit",
        actor: buildActor(audit?.sessionId, audit?.actor),
        action: "mcp.server.disconnect",
        resource: name,
        verdict: "continue",
        reason: "MCP server disconnected",
        ...base,
      }),
      { beforeSideEffect: false, parentActionId: requested?.actionId },
    );
  }

  async disconnectAll(context?: McpLifecycleAuditContext): Promise<void> {
    const serverNames = [...this.clients.keys()];
    const audit = resolveLifecycleAudit(context);
    const requested = await this.appendLifecycleEvent(
      audit,
      "action_requested",
      "lifecycle.disconnect_all",
      (base): ExecutionEvent.ActionRequested => ({
        type: "action_requested",
        actor: buildActor(audit?.sessionId, audit?.actor),
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        input: { serverNames },
        ...base,
      }),
      { beforeSideEffect: true },
    );
    const disconnects = [...this.clients.entries()].map(async ([name, client]) => {
      await client.disconnect().catch(() => undefined);
      this.connected.delete(name);
    });
    await Promise.all(disconnects);
    this.clients.clear();
    this.cachedTools = null;
    await this.appendLifecycleEvent(
      audit,
      "action_approved",
      "lifecycle.disconnect_all",
      (base): ExecutionEvent.ActionApproved => ({
        type: "action_approved",
        policyId: "mcp.lifecycle-audit",
        actor: buildActor(audit?.sessionId, audit?.actor),
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        verdict: "continue",
        reason: "MCP servers disconnected",
        ...base,
      }),
      { beforeSideEffect: false, parentActionId: requested?.actionId },
    );
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
      const result = {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: guard.verdict.reason ?? `Unknown tool: ${call.tool}`,
        isError: true,
      };
      await this.appendActionBlocked(call, guard.verdict, tool?.spec.name ?? call.tool);
      return result;
    }

    let parentActionId: string | undefined;
    try {
      const requested = await this.appendLedgerEvent(
        call,
        "action_requested",
        (base): ExecutionEvent.ActionRequested => ({
          type: "action_requested",
          actor: buildActor(readSessionId(call)),
          action: MCP_TOOL_ACTION,
          resource: tool.spec.name,
          input: call.input,
          ...base,
        }),
        { beforeSideEffect: true, tool },
      );
      parentActionId = requested?.actionId;
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }

    const startTime = Date.now();
    const result = await tool.execute({ ...call, tool: tool.spec.name });

    await this.appendLedgerEvent(
      call,
      "tool_completed",
      (base): ExecutionEvent.ToolCompleted => ({
        type: "tool_completed",
        toolCallId: call.id,
        result,
        ...base,
      }),
      { beforeSideEffect: false, parentActionId },
    );

    if (!result.isError) {
      const durationMs = Date.now() - startTime;
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

  private async appendActionBlocked(
    call: Tool.Call,
    verdict: { readonly action: string; readonly policyId?: string; readonly reason?: string },
    resource: string,
  ): Promise<void> {
    await this.appendLedgerEvent(
      call,
      "action_blocked",
      (base): ExecutionEvent.ActionBlocked => ({
        type: "action_blocked",
        policyId: verdict.policyId ?? "mcp.prefix-guard",
        actor: buildActor(readSessionId(call)),
        action: MCP_TOOL_ACTION,
        resource,
        verdict: "abort",
        reason: verdict.reason ?? `Unknown tool: ${call.tool}`,
        ...base,
      }),
      { beforeSideEffect: false },
    );
  }

  private async appendLedgerEvent(
    call: Tool.Call,
    eventType: ExecutionEvent["type"],
    event: (base: {
      readonly actionId: string;
      readonly parentActionId?: string;
      readonly visibility: typeof MCP_LEDGER_VISIBILITY;
      readonly timestamp: string;
      readonly sequence: number;
    }) => ExecutionEvent,
    options: {
      readonly beforeSideEffect: boolean;
      readonly parentActionId?: string;
      readonly tool?: NativeTool;
    },
  ): Promise<ExecutionEvent | undefined> {
    const sessionId = readSessionId(call);
    if (!sessionId) return undefined;

    const shouldBlock = shouldBlockOnPreAppend(options.tool, options.beforeSideEffect);
    return this.appendEventWithAudit(
      {
        sessionId,
        correlationId: call.id,
        eventType,
        shouldBlock,
        logContext: { toolCallId: call.id, toolName: call.tool },
      },
      event,
      options.parentActionId,
    );
  }

  private async appendLifecycleEvent(
    audit: ResolvedLifecycleAudit | undefined,
    eventType: ExecutionEvent["type"],
    correlationId: string,
    event: (base: {
      readonly actionId: string;
      readonly parentActionId?: string;
      readonly visibility: typeof MCP_LEDGER_VISIBILITY;
      readonly timestamp: string;
      readonly sequence: number;
    }) => ExecutionEvent,
    options: { readonly beforeSideEffect: boolean; readonly parentActionId?: string },
  ): Promise<ExecutionEvent | undefined> {
    if (!audit) return undefined;
    return this.appendEventWithAudit(
      {
        sessionId: audit.sessionId,
        correlationId,
        eventType,
        shouldBlock: options.beforeSideEffect,
        logContext: { toolName: correlationId },
      },
      event,
      options.parentActionId,
    );
  }

  private async appendEventWithAudit(
    audit: {
      readonly sessionId: string;
      readonly correlationId: string;
      readonly eventType: ExecutionEvent["type"];
      readonly shouldBlock: boolean;
      readonly logContext: { readonly toolCallId?: string; readonly toolName: string };
    },
    event: (base: {
      readonly actionId: string;
      readonly parentActionId?: string;
      readonly visibility: typeof MCP_LEDGER_VISIBILITY;
      readonly timestamp: string;
      readonly sequence: number;
    }) => ExecutionEvent,
    parentActionId: string | undefined,
  ): Promise<ExecutionEvent | undefined> {
    const { sessionId, correlationId, eventType, shouldBlock } = audit;
    const unavailableReason = ledgerUnavailableReason(sessionId);
    if (unavailableReason !== undefined) {
      if (shouldBlock) throw new Error(unavailableReason);
      return undefined;
    }

    return this.withSessionAppendLock(sessionId, async () => {
      try {
        const sequence = await readNextSequence(sessionId);
        const row = event({
          actionId: ledgerActionId(sessionId, correlationId, eventType, sequence),
          ...(parentActionId !== undefined && { parentActionId }),
          visibility: MCP_LEDGER_VISIBILITY,
          timestamp: new Date().toISOString(),
          sequence,
        });
        await EventLog.append(sessionId, row);
        return row;
      } catch (error) {
        if (shouldBlock) throw error;
        Log.warn("mcp provider: EventLog append failed", {
          ...audit.logContext,
          sessionId,
          error: String(error),
        });
        return undefined;
      }
    });
  }

  private withSessionAppendLock<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
    const previous = this.appendLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    this.appendLocks.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
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
  return {
    serverName: config.name,
    transport: config.transport,
    ...(config.command !== undefined && { command: config.command }),
    ...(config.url !== undefined && { url: config.url }),
    ...(config.args !== undefined && { argsCount: config.args.length }),
    ...(config.timeout !== undefined && { timeout: config.timeout }),
    ...(config.retries !== undefined && { retries: config.retries }),
    ...(config.headers !== undefined && { headerNames: Object.keys(config.headers).sort() }),
  };
}

async function readNextSequence(sessionId: string): Promise<number> {
  let maxSequence = 0;
  for await (const event of EventLog.replay(sessionId)) {
    maxSequence = Math.max(maxSequence, event.sequence);
  }
  return maxSequence + 1;
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

function ledgerUnavailableReason(sessionId: string): string | undefined {
  const adapter = Storage.get();
  if (adapter.eventLog === undefined) return "EventLog adapter unavailable for mandatory MCP audit";
  if (adapter.session.get(sessionId) === undefined) {
    return "Session unavailable for mandatory MCP audit";
  }
  return undefined;
}

function shouldBlockOnPreAppend(tool: NativeTool | undefined, beforeSideEffect: boolean): boolean {
  if (!beforeSideEffect || !tool) return false;
  return tool.riskTier >= 1 || !tool.isReadOnly;
}

function ledgerActionId(
  sessionId: string,
  toolCallId: string,
  eventType: ExecutionEvent["type"],
  sequence: number,
): string {
  return `${sessionId}:mcp.${eventType}:${toolCallId}:${sequence}`;
}

function createResultSummary(output: unknown): string {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output);
  const length = outputStr.length;
  return `success:text:${length}b`;
}
