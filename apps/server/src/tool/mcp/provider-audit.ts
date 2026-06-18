import type { McpServerConfig, Tool } from "@openomni/protocol";
import { PolicyEvent } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { McpLifecycleAuditContext, ResolvedLifecycleAudit } from "./provider-types";

/** @internal Package-local helper for McpToolProvider only. */
export const MCP_TOOL_ACTION = "mcp.tool.call";

/** @internal Package-local helper for McpToolProvider only. */
export type McpLifecycleAction =
  | "mcp.server.connect"
  | "mcp.server.disconnect"
  | "mcp.server.disconnect_all";

/** @internal Package-local helper for McpToolProvider only. */
export function resolveLifecycleAudit(
  context: McpLifecycleAuditContext | undefined,
): ResolvedLifecycleAudit | undefined {
  const sessionId = context?.audit?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return undefined;
  }
  return {
    sessionId,
    ...(context?.actor !== undefined && { actor: context.actor }),
  };
}

/** @internal Package-local helper for McpToolProvider only. */
export function publishLifecycleRequested(input: {
  readonly audit: ResolvedLifecycleAudit;
  readonly actionId: string;
  readonly action: McpLifecycleAction;
  readonly resource: string;
  readonly context?: Record<string, unknown>;
}): void {
  Bus.publish(PolicyEvent.ActionRequested, {
    ...lifecycleBase(input.audit),
    actionId: input.actionId,
    actor: buildActor(input.audit.sessionId, input.audit.actor),
    action: input.action,
    resource: input.resource,
    ...(input.context !== undefined ? { context: input.context } : {}),
  });
}

/** @internal Package-local helper for McpToolProvider only. */
export function publishLifecycleApproved(input: {
  readonly audit: ResolvedLifecycleAudit;
  readonly actionId: string;
  readonly action: McpLifecycleAction;
  readonly resource: string;
  readonly reason: string;
}): void {
  Bus.publish(PolicyEvent.ActionApproved, {
    ...lifecycleBase(input.audit),
    actionId: input.actionId,
    actor: buildActor(input.audit.sessionId, input.audit.actor),
    action: input.action,
    resource: input.resource,
    verdict: "allow" as const,
    reason: input.reason,
  });
}

/** @internal Package-local helper for McpToolProvider only. */
export function publishLifecycleBlocked(input: {
  readonly audit: ResolvedLifecycleAudit;
  readonly actionId: string;
  readonly action: McpLifecycleAction;
  readonly resource: string;
  readonly reason: string;
}): void {
  Bus.publish(PolicyEvent.ActionBlocked, {
    ...lifecycleBase(input.audit),
    actionId: input.actionId,
    actor: buildActor(input.audit.sessionId, input.audit.actor),
    action: input.action,
    resource: input.resource,
    verdict: "deny" as const,
    reason: input.reason,
  });
}

/** @internal Package-local helper for McpToolProvider only. */
export function summarizeServerConfig(config: McpServerConfig): Record<string, unknown> {
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

/** @internal Package-local helper for McpToolProvider only. */
export function readSessionId(call: Tool.Call): string | undefined {
  const sessionId = call.input.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/** @internal Package-local helper for McpToolProvider only. */
export function buildActor(
  sessionId: string | undefined,
  actor: Record<string, unknown> | undefined = undefined,
): Record<string, unknown> {
  return {
    ...(actor ?? {}),
    kind: "mcp_provider",
    ...(sessionId !== undefined && { sessionId }),
  };
}

function lifecycleBase(audit: ResolvedLifecycleAudit) {
  return {
    traceId: crypto.randomUUID(),
    sessionId: audit.sessionId,
    time: Date.now(),
  };
}
