import {
  MiddlewareEngine,
  type MiddlewareDecision,
  type MiddlewareRegistration,
} from "@openomni/agent";
import type { Hook, Middleware, Tool, TraceContext } from "@openomni/protocol";
import type { NativeTool } from "@openomni/openomni";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const policyId = "mcp.prefix-guard";

interface PrefixGuardState {
  readonly call: Tool.Call;
  readonly tools: readonly NativeTool[];
  readonly isServerConnected: (serverName: string) => boolean;
  tool?: NativeTool;
  serverName?: string;
}

function continueVerdict(reason: string): Hook.Verdict {
  return { action: "continue", reason, policyId };
}

function abortVerdict(reason: string): Hook.Verdict {
  return { action: "abort", reason, policyId };
}

function resolveTool(tools: readonly NativeTool[], name: string): NativeTool | undefined {
  const dottedName = name.replace(/_/g, ".");
  return tools.find((entry) => entry.spec.name === name || entry.spec.name === dottedName);
}

function createMcpPrefixGuard(state: PrefixGuardState): MiddlewareRegistration {
  return {
    ...McpPrefixGuardMiddleware.Definition,
    failPolicy: "fail-closed",
    fn: () => {
      const tool = resolveTool(state.tools, state.call.tool);
      if (!tool) {
        return abortVerdict(`Unknown tool: ${state.call.tool}`);
      }

      state.tool = tool;
      const dotIndex = tool.spec.name.indexOf(".");
      if (dotIndex === -1) {
        return abortVerdict(`MCP tool name must be prefixed with server name: ${tool.spec.name}`);
      }

      const serverName = tool.spec.name.slice(0, dotIndex);
      state.serverName = serverName;
      if (!state.isServerConnected(serverName)) {
        return abortVerdict(`MCP server not found: ${serverName}`);
      }

      return continueVerdict("mcp tool prefix and server connection validated");
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
    readonly onDecision?: (decision: MiddlewareDecision) => void | Promise<void>;
  }

  export interface PreToolUseResult {
    readonly verdict: Hook.Verdict;
    readonly tool?: NativeTool;
    readonly serverName?: string;
  }

  export function registrations(state: PrefixGuardState): MiddlewareRegistration[] {
    return [createMcpPrefixGuard(state)];
  }

  export async function evaluatePreToolUse(ctx: PreToolUseContext): Promise<PreToolUseResult> {
    const state: PrefixGuardState = {
      call: ctx.call,
      tools: ctx.tools,
      isServerConnected: ctx.isServerConnected,
    };
    let lastDecision: MiddlewareDecision | undefined;
    const engine = MiddlewareEngine.create({
      traceContext: ctx.traceContext,
      onDecision: async (decision) => {
        lastDecision = decision;
        await ctx.onDecision?.(decision);
      },
      eventLog: false,
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
        ? continueVerdict(lastDecision.reason ?? "continue")
        : verdict;

    return {
      verdict: finalVerdict,
      ...(state.tool !== undefined && { tool: state.tool }),
      ...(state.serverName !== undefined && { serverName: state.serverName }),
    };
  }
}
