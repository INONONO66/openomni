import { describe, expect, it, mock } from "bun:test";
import { PolicyDecision, type Tool } from "@openomni/protocol";
import { createToolExecutor } from "../../../../src/core/execution/tool-executor";
import {
  PolicyEngine,
  type PolicyContext,
  type PolicyRegistration,
} from "../../../../src/core/policy";

const itSkip = Reflect.get(it, "skip") as (label: string, fn: () => void) => void;
const documentedSkip = () => {
  void 0;
};

/**
 * Canonical equivalent of the legacy `invoke.prepare` deny-all: one
 * registration bound to every invoke-boundary pre point, so no tool or
 * delegation path can route around the deny by picking a different point.
 */
function denyAllInvokePre(reason: string): PolicyRegistration {
  return {
    kind: "point",
    name: "conformance:deny-all:invoke-pre",
    pointIds: ["tool.native.pre", "tool.mcp.pre", "delegation.worker.pre"],
    effectCapabilities: {
      "tool.native.pre": ["run.abort"],
      "tool.mcp.pre": ["run.abort"],
      "delegation.worker.pre": ["run.abort"],
    },
    priority: 0,
    failPolicy: "fail-closed",
    fn: () =>
      PolicyDecision.deny({
        policyId: "conformance.invoke-pre.deny-all",
        reasonCodes: [reason],
        effects: [{ type: "run.abort", reason }],
      }),
  };
}

function denyAllContextPre(reason: string): PolicyRegistration {
  return {
    kind: "point",
    name: "conformance:deny-all:prompt.context.pre",
    pointIds: ["prompt.context.pre"],
    effectCapabilities: { "prompt.context.pre": ["audit.annotate"] },
    priority: 0,
    failPolicy: "fail-closed",
    fn: () =>
      PolicyDecision.deny({
        policyId: "conformance.prompt.context.pre.deny-all",
        reasonCodes: [reason],
        effects: [{ type: "audit.annotate", annotation: reason, severity: "error" }],
      }),
  };
}

function basePolicyContext(): Omit<PolicyContext, "timing"> {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

describe("policy no-bypass conformance — agent governed paths", () => {
  it("blocks native tool invocation before the native executor runs", async () => {
    const nativeExecutor = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: "native-result",
        toolCallId: call.id,
        output: "executed",
        isError: false,
      }),
    );
    const engine = PolicyEngine.create();
    engine.register(denyAllInvokePre("native tool denied by conformance policy"));

    const executor = createToolExecutor({
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      toolExecutor: nativeExecutor,
      engine,
    });
    const result = await executor({ id: "native-call", tool: "bash", input: { command: "date" } });

    expect(nativeExecutor).toHaveBeenCalledTimes(0);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("native tool denied by conformance policy");
  });

  it("blocks MCP tool invocation through the agent tool executor", async () => {
    const mcpExecutor = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: "mcp-result",
        toolCallId: call.id,
        output: "remote side effect",
        isError: false,
      }),
    );
    const capturedLabels: string[][] = [];
    const engine = PolicyEngine.create();
    engine.register({
      ...denyAllInvokePre("mcp tool denied by conformance policy"),
      fn: (ctx) => {
        capturedLabels.push(ctx.toolLabels ?? []);
        return PolicyDecision.deny({
          policyId: "conformance.mcp.deny-all",
          reasonCodes: ["mcp tool denied by conformance policy"],
          effects: [{ type: "run.abort", reason: "mcp tool denied by conformance policy" }],
        });
      },
    });

    const executor = createToolExecutor({
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      toolExecutor: mcpExecutor,
      engine,
      getToolLabels: () => ["source.mcp", "mcp.fixture"],
    });
    const result = await executor({ id: "mcp-call", tool: "mcp_fixture_read", input: {} });

    expect(mcpExecutor).toHaveBeenCalledTimes(0);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("mcp tool denied by conformance policy");
    expect(capturedLabels).toEqual([["source.mcp", "mcp.fixture"]]);
  });

  it("blocks system prompt composition before prompt content is returned", async () => {
    const engine = PolicyEngine.create();
    engine.register(denyAllContextPre("system prompt denied by conformance policy"));

    const decision = await engine.dispatchPoint("prompt.context.pre", {
      ...basePolicyContext(),
      sessionId: "session",
      runId: "run",
      turnIndex: 0,
    });
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("system prompt denied by conformance policy");
  });
});

describe("policy no-bypass conformance — known ungoverned paths", () => {
  itSkip(
    "UNGOVERNED: Direct MCP client packages/agent/src/runtime/mcp/client.ts:callTool() — no policy check before remote tool call",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Worker spawn packages/coordinator/src/worker-supervision/supervisor.ts:doStart() — no policy check",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Worker IPC dispatch packages/ipc/src/server.ts — no policy check",
    documentedSkip,
  );
  itSkip("UNGOVERNED: Direct LLM run packages/llm/src/run.ts — no policy check", documentedSkip);
  itSkip(
    "UNGOVERNED: Session direct writes packages/session/src/session/index.ts — no policy gate",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Artifact writes packages/session/src/artifact/index.ts — no policy gate",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: WorkItem writes packages/session/src/work-item/index.ts — no policy gate",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Skill load/activation packages/openomni/src/skill/index.ts — no authorization policy point yet",
    documentedSkip,
  );
});
