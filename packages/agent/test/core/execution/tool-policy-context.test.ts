import { describe, expect, it } from "bun:test";
import { PolicyDecision, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createToolExecutor } from "../../../src/core/execution/tools";
import { PolicyEngine, type CanonicalPolicyRegistration } from "../../../src/core/policy";
import { ChatAgent } from "../../../src/core/chat-agent";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

/**
 * What the executor hands a `tool.native.pre` policy. Half of what the
 * tool-permission integration suite used to prove lived here and not in the
 * policy: a permission ruleset can only match on labels and a canonical name
 * if the executor puts them in the context. How a ruleset then *interprets*
 * them is the policy's, and moved to openomni with it (#629).
 */
function engineRegistration(seen: Array<Record<string, unknown>>) {
  return {
    kind: "point",
    name: "test:tool-pre-observer",
    pointIds: ["tool.native.pre"],
    effectCapabilities: { "tool.native.pre": [] },
    priority: 0,
    fn: (ctx) => {
      seen.push({
        toolName: ctx.toolName,
        toolLabels: ctx.toolLabels,
      });
      return PolicyDecision.allow({ policyId: "test.tool-pre-observer" });
    },
  } satisfies CanonicalPolicyRegistration;
}

function observingEngine(seen: Array<Record<string, unknown>>) {
  const engine = PolicyEngine.create();
  engine.register(engineRegistration(seen));
  return engine;
}

function run(engine: ReturnType<typeof PolicyEngine.create>, call: Tool.Call, labels: string[]) {
  const executor = createToolExecutor({
    events: Bus,
    traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
    engine,
    getToolLabels: (name) => (name === call.tool ? labels : undefined),
    toolExecutor: async (c) => ({
      id: "result-1",
      toolCallId: c.id,
      output: "ok",
      isError: false,
    }),
  });
  return executor(call);
}

describe("tool policy context", () => {
  it("carries the tool's declared labels", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await run(observingEngine(seen), { id: "call-1", tool: "write", input: { path: "f.txt" } }, [
      "capability:write",
      "risk:tier-1",
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolLabels).toEqual(["capability:write", "risk:tier-1"]);
  });

  it("presents the canonical policy name, not the invoked alias", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const engine = observingEngine(seen);
    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      engine,
      // A ruleset is written against canonical names; the model calls the
      // sanitized alias. Resolving one to the other is the executor's, which
      // is why a permission ruleset never has to know about aliases.
      getPolicyToolName: (name) => (name === "grep_search" ? "grep.search" : undefined),
      toolExecutor: async (c) => ({
        id: "result-1",
        toolCallId: c.id,
        output: "ok",
        isError: false,
      }),
    });

    await executor({ id: "call-2", tool: "grep_search", input: { pattern: "x" } });

    expect(seen[0]?.toolName).toBe("grep.search");
  });
});

/**
 * One layer up, and the layer #629's first decomposition missed. The tests
 * above hand `getToolLabels` / `getPolicyToolName` to the executor directly,
 * so they pin that it *consumes* them — not that `buildTurn` derives them from
 * `config.tools`. That derivation is what makes a permission ruleset able to
 * name a tool at all, and it was covered only by the integration suite this
 * PR decomposed.
 */
describe("tool policy context through a run", () => {
  it("derives labels and the canonical policy name from the tool spec", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const agent = ChatAgent.create({
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (input, sink) => {
          const call: Tool.Call = {
            id: "call-derived",
            tool: "grep_search",
            input: { pattern: "x" },
          };
          if (input.toolExecutor) sink.onToolResult(await input.toolExecutor(call));
          return createStopOutcome();
        },
      }),
      tools: [
        {
          name: "grep_search",
          inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
          labels: ["tool:grep.search", "capability:read"],
        },
      ],
      toolExecutor: async (call) => ({
        id: "result-derived",
        toolCallId: call.id,
        output: "ok",
        isError: false,
      }),
      middleware: [engineRegistration(seen)],
    });

    await agent.run(runInput([{ role: "user", content: "search" }]));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolName).toBe("grep.search");
    expect(seen[0]?.toolLabels).toEqual(["tool:grep.search", "capability:read"]);
  });
});
