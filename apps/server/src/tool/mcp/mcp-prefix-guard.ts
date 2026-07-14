import {
  PolicyEngine,
  type CanonicalPolicyRegistrationGeneric,
  type GenericPolicyContext,
} from "@openomni/policy";
import {
  Policy,
  PolicyDecision,
  type RuntimeResource,
  type Tool,
  type TraceContext,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { NativeTool } from "@openomni/openomni";

type McpPolicyContext = GenericPolicyContext;

interface PrefixGuardState {
  readonly call: Tool.Call;
  readonly tool?: NativeTool;
  readonly serverName: string;
  readonly isServerConnected: (serverName: string) => boolean;
}

interface PreToolUseContext {
  readonly call: Tool.Call;
  readonly tools: readonly NativeTool[];
  readonly isServerConnected: (serverName: string) => boolean;
  readonly traceContext?: TraceContext.Type;
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
}

interface PreToolUseResult {
  readonly verdict: Policy.PolicyDecision;
  readonly tool?: NativeTool;
  readonly serverName?: string;
}

function evaluatePrefixGuard(input: {
  readonly call: Tool.Call;
  readonly resource: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
  readonly serverName?: string;
}): Policy.PolicyDecision {
  const action = "mcp.tool.call";
  return PolicyDecision.fromEvaluation(
    Policy.evaluate(
      {
        action,
        inputRules: [
          {
            toolPattern: input.resource,
            field: "allowed",
            pattern: "^true$",
            action: "allow",
            reason: input.allowReason,
            priority: 2,
          },
          {
            toolPattern: input.resource,
            field: "allowed",
            pattern: "^false$",
            action: "deny",
            reason: input.denyReason,
            priority: 1,
          },
        ],
      },
      {
        action,
        resource: input.resource,
        input: { ...input.call.input, allowed: String(input.allowed) },
        metadata: { callTool: input.call.tool, serverName: input.serverName },
      },
    ),
    { denyEffect: { type: "tool.skip_invocation", reason: input.denyReason } },
  );
}

function resolveTool(tools: readonly NativeTool[], name: string): NativeTool | undefined {
  const dottedName = name.replace(/_/g, ".");
  return tools.find((entry) => entry.spec.name === name || entry.spec.name === dottedName);
}

function createMcpDescriptor(
  attemptedToolName: string,
  tool: NativeTool | undefined,
  serverName: string | undefined,
): RuntimeResource.Descriptor {
  if (tool?.descriptor) return tool.descriptor;

  const toolName = tool?.spec.name ?? attemptedToolName;
  const labels = tool?.spec.labels ?? tool?.labels ?? ["source.mcp"];
  return {
    id: `tool:mcp:${toolName}`,
    kind: "tool",
    source: { type: "mcp", ...(serverName !== undefined && { serverId: serverName }) },
    labels: [...labels],
    capabilities: [],
    effects: [],
  };
}

function resolveMcpServerId(tool: NativeTool): string | undefined {
  const descriptorSource = tool.descriptor?.source;
  if (descriptorSource?.type === "mcp" && descriptorSource.serverId) {
    return descriptorSource.serverId;
  }

  const dotIndex = tool.spec.name.indexOf(".");
  return dotIndex > 0 ? tool.spec.name.slice(0, dotIndex) : undefined;
}

function resolveAttemptedServerId(toolName: string): string | undefined {
  const dottedName = toolName.replace(/_/g, ".");
  const dotIndex = dottedName.indexOf(".");
  return dotIndex > 0 ? dottedName.slice(0, dotIndex) : undefined;
}

function createMcpPrefixGuard(
  state: PrefixGuardState,
): CanonicalPolicyRegistrationGeneric<McpPolicyContext> {
  return {
    ...McpPrefixGuardMiddleware.Definition,
    fn: () => {
      if (!state.tool) {
        return evaluatePrefixGuard({
          call: state.call,
          resource: state.call.tool,
          allowed: false,
          allowReason: "mcp tool prefix and server connection validated",
          denyReason: `Unknown tool: ${state.call.tool}`,
          serverName: state.serverName,
        });
      }

      if (!state.isServerConnected(state.serverName)) {
        return evaluatePrefixGuard({
          call: state.call,
          resource: state.tool.spec.name,
          allowed: false,
          allowReason: "mcp tool prefix and server connection validated",
          denyReason: `MCP server not found: ${state.serverName}`,
          serverName: state.serverName,
        });
      }

      return evaluatePrefixGuard({
        call: state.call,
        resource: state.tool.spec.name,
        allowed: true,
        allowReason: "mcp tool prefix and server connection validated",
        denyReason: `MCP server not found: ${state.serverName}`,
        serverName: state.serverName,
      });
    },
  };
}

export namespace McpPrefixGuardMiddleware {
  export const Definition = {
    kind: "point",
    name: "mcp-prefix-guard",
    pointIds: ["tool.mcp.pre"],
    effectCapabilities: {
      "tool.mcp.pre": ["tool.skip_invocation", "audit.annotate"],
    },
    priority: 0,
    failPolicy: "fail-closed",
  } as const satisfies Omit<CanonicalPolicyRegistrationGeneric<McpPolicyContext>, "fn">;

  export async function evaluatePreToolUse(ctx: PreToolUseContext): Promise<PreToolUseResult> {
    const tool = resolveTool(ctx.tools, ctx.call.tool);
    const serverName =
      tool === undefined ? resolveAttemptedServerId(ctx.call.tool) : resolveMcpServerId(tool);

    const sessionId = ctx.traceContext?.sessionId ?? crypto.randomUUID();
    const runId = ctx.traceContext?.runId ?? crypto.randomUUID();
    const traceContext: TraceContext.Type = {
      ...(ctx.traceContext ?? {}),
      traceId: ctx.traceContext?.traceId ?? crypto.randomUUID(),
      sessionId,
      runId,
    };
    const engine = PolicyEngine.create<McpPolicyContext>({
      traceContext,
      onDecision: ctx.onDecision,
      auditEmit: Bus.publish,
    });
    if (serverName !== undefined) {
      engine.register(
        createMcpPrefixGuard({
          call: ctx.call,
          ...(tool !== undefined && { tool }),
          serverName,
          isServerConnected: ctx.isServerConnected,
        }),
      );
    }

    const verdict = await engine.dispatchPoint("tool.mcp.pre", {
      sessionId,
      runId,
      toolId: tool?.spec.name ?? ctx.call.tool,
      ...(serverName !== undefined && { mcpServerId: serverName }),
      toolName: ctx.call.tool,
      toolCallId: ctx.call.id,
      toolInput: ctx.call.input,
      traceContext,
      resourceDescriptor: createMcpDescriptor(ctx.call.tool, tool, serverName),
    });

    let returnedVerdict = verdict;
    if (
      tool !== undefined &&
      serverName === undefined &&
      PolicyDecision.isBlocking(verdict) &&
      verdict.reasonCodes.includes("policy.context_missing")
    ) {
      returnedVerdict = {
        ...verdict,
        reasonCodes: [
          `MCP tool name must be prefixed with server name: ${tool.spec.name}`,
          ...verdict.reasonCodes,
        ],
      };
    }

    return {
      verdict: returnedVerdict,
      ...(tool !== undefined && { tool }),
      ...(serverName !== undefined && { serverName }),
    };
  }
}
