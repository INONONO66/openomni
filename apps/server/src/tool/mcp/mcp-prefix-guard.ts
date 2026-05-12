import { PolicyEngine, type PolicyDecision, type PolicyRegistration } from "@openomni/agent";
import {
  Policy,
  type Hook,
  type Middleware,
  type Tool,
  type TraceContext,
} from "@openomni/protocol";
import type { NativeTool } from "@openomni/openomni";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

interface PrefixGuardState {
  readonly call: Tool.Call;
  readonly tools: readonly NativeTool[];
  readonly isServerConnected: (serverName: string) => boolean;
  tool?: NativeTool;
  serverName?: string;
}

function evaluatePrefixGuard(input: {
  readonly call: Tool.Call;
  readonly resource: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
  readonly serverName?: string;
}): Hook.Verdict {
  const action = "mcp.tool.call";
  return Policy.evaluate(
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
  );
}

function resolveTool(tools: readonly NativeTool[], name: string): NativeTool | undefined {
  const dottedName = name.replace(/_/g, ".");
  return tools.find((entry) => entry.spec.name === name || entry.spec.name === dottedName);
}

function createMcpPrefixGuard(state: PrefixGuardState): PolicyRegistration {
  return {
    ...McpPrefixGuardMiddleware.Definition,
    failPolicy: "fail-closed",
    fn: () => {
      const tool = resolveTool(state.tools, state.call.tool);
      if (!tool) {
        return evaluatePrefixGuard({
          call: state.call,
          resource: state.call.tool,
          allowed: false,
          allowReason: "mcp tool prefix and server connection validated",
          denyReason: `Unknown tool: ${state.call.tool}`,
        });
      }

      state.tool = tool;
      const dotIndex = tool.spec.name.indexOf(".");
      if (dotIndex === -1) {
        return evaluatePrefixGuard({
          call: state.call,
          resource: tool.spec.name,
          allowed: false,
          allowReason: "mcp tool prefix and server connection validated",
          denyReason: `MCP tool name must be prefixed with server name: ${tool.spec.name}`,
        });
      }

      const serverName = tool.spec.name.slice(0, dotIndex);
      state.serverName = serverName;
      if (!state.isServerConnected(serverName)) {
        return evaluatePrefixGuard({
          call: state.call,
          resource: tool.spec.name,
          allowed: false,
          allowReason: "mcp tool prefix and server connection validated",
          denyReason: `MCP server not found: ${serverName}`,
          serverName,
        });
      }

      return evaluatePrefixGuard({
        call: state.call,
        resource: tool.spec.name,
        allowed: true,
        allowReason: "mcp tool prefix and server connection validated",
        denyReason: `MCP server not found: ${serverName}`,
        serverName,
      });
    },
  };
}

export namespace McpPrefixGuardMiddleware {
  export const Definition = {
    name: "mcp-prefix-guard",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export interface PreToolUseContext {
    readonly call: Tool.Call;
    readonly tools: readonly NativeTool[];
    readonly isServerConnected: (serverName: string) => boolean;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: PolicyDecision) => void | Promise<void>;
  }

  export interface PreToolUseResult {
    readonly verdict: Hook.Verdict;
    readonly tool?: NativeTool;
    readonly serverName?: string;
  }

  export function registrations(state: PrefixGuardState): PolicyRegistration[] {
    return [createMcpPrefixGuard(state)];
  }

  export async function evaluatePreToolUse(ctx: PreToolUseContext): Promise<PreToolUseResult> {
    const state: PrefixGuardState = {
      call: ctx.call,
      tools: ctx.tools,
      isServerConnected: ctx.isServerConnected,
    };
    let lastDecision: PolicyDecision | undefined;
    const engine = PolicyEngine.create({
      traceContext: ctx.traceContext,
      onDecision: async (decision) => {
        lastDecision = decision;
        await ctx.onDecision?.(decision);
      },
      audit: false,
    });

    for (const registration of registrations(state)) {
      engine.register(registration);
    }

    const verdict = await engine.dispatch("pre_tool_use", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: ctx.call.tool,
      toolCallId: ctx.call.id,
      toolInput: ctx.call.input,
      traceContext: ctx.traceContext,
    });

    const finalVerdict =
      verdict.action === "continue" && lastDecision?.verdict === "continue"
        ? {
            action: "continue" as const,
            policyId: lastDecision.policyId,
            reason: lastDecision.reason ?? "continue",
          }
        : verdict;

    return {
      verdict: finalVerdict,
      ...(state.tool !== undefined && { tool: state.tool }),
      ...(state.serverName !== undefined && { serverName: state.serverName }),
    };
  }
}
