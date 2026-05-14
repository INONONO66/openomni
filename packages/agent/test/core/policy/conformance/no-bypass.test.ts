import { describe, expect, it, mock } from "bun:test";
import type { Messenger, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { createToolExecutor } from "../../../../src/core/execution/tool-executor";
import {
  createStreamRunState,
  dispatchWritebackCommit,
} from "../../../../src/core/execution/stream-helpers";
import {
  PolicyEngine,
  type PolicyContext,
  type PolicyRegistration,
} from "../../../../src/core/policy";
import { AgentMessenger, type Transport } from "../../../../src/runtime/messenger/messenger";

const itSkip = Reflect.get(it, "skip") as (label: string, fn: () => void) => void;
const documentedSkip = () => {
  void 0;
};

function denyAll(timing: PolicyRegistration["timing"], reason: string): PolicyRegistration {
  return {
    name: `conformance:deny-all:${timing}`,
    timing,
    priority: 0,
    failPolicy: "fail-closed",
    fn: () => ({ action: "deny", reason, policyId: `conformance.${timing}.deny-all` }),
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

function envelope(fromAgentId: string, toAgentId: string): Messenger.MessageEnvelope {
  return {
    id: "env-no-bypass",
    traceId: "trace-no-bypass",
    correlationId: null,
    sessionId: "session-no-bypass",
    runId: "run-no-bypass",
    fromAgentId,
    toAgentId,
    sentAt: new Date().toISOString(),
    schemaRef: "test",
    payload: {},
    persistencePolicy: "both",
  };
}

function makeTransport(): Transport & { readonly sendMock: ReturnType<typeof mock> } {
  const sendMock = mock(async () => undefined);
  return {
    sendMock,
    send: sendMock,
    subscribe: () => () => undefined,
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
    engine.register(denyAll("invoke.prepare", "native tool denied by conformance policy"));

    const executor = createToolExecutor({ toolExecutor: nativeExecutor, engine });
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
      ...denyAll("invoke.prepare", "mcp tool denied by conformance policy"),
      fn: (ctx) => {
        capturedLabels.push(ctx.toolLabels ?? []);
        return {
          action: "deny" as const,
          reason: "mcp tool denied by conformance policy",
          policyId: "conformance.mcp.deny-all",
        };
      },
    });

    const executor = createToolExecutor({
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

  it("blocks messenger send before transport delivery", async () => {
    const transport = makeTransport();
    const messenger = AgentMessenger.create(transport, {
      allowPatterns: [{ from: "allowed", to: "allowed" }],
    });

    const error = await messenger.send(envelope("blocked", "worker")).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Authorization denied");
    expect(transport.sendMock).toHaveBeenCalledTimes(0);
    Bus.reset();
  });

  it("blocks system prompt composition before prompt content is returned", async () => {
    const engine = PolicyEngine.create();
    engine.register(denyAll("context.prepare", "system prompt denied by conformance policy"));

    const error = await engine
      .dispatchSystemPrompt(basePolicyContext())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("system prompt denied by conformance policy");
  });

  it("blocks writeback commit before final output is committed", async () => {
    const engine = PolicyEngine.create();
    engine.register(denyAll("writeback.commit", "writeback denied by conformance policy"));
    const state = createStreamRunState({ messages: [{ role: "user", content: "hello" }] });

    const error = await dispatchWritebackCommit(
      state,
      engine,
      { model: { provider: "anthropic", id: "claude-3-haiku-20240307" } },
      "final answer",
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("writeback denied by conformance policy");
  });
});

describe("policy no-bypass conformance — known ungoverned paths", () => {
  itSkip(
    "UNGOVERNED: Direct MCP client packages/agent/src/runtime/mcp/client.ts:callTool() — no policy check before remote tool call",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Worker spawn packages/coordinator/src/worker-pool/supervisor.ts:doStart() — no policy check",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Worker IPC dispatch packages/coordinator/src/ipc/server.ts — no policy check",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Credential injection packages/coordinator/src/credentials/injector.ts — no policy check",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Tool permission partial packages/coordinator/src/tool-permission/policy.ts — exists but disconnected from v2",
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
    "UNGOVERNED: Todo writes packages/session/src/todo/index.ts — no policy gate",
    documentedSkip,
  );
  itSkip(
    "UNGOVERNED: Skill load/activation packages/openomni/src/skill/index.ts — no authorization policy point yet",
    documentedSkip,
  );
});
