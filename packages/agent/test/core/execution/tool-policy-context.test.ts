import { describe, expect, it } from "bun:test";
import { PolicyDecision, type Policy, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createToolExecutor } from "../../../src/core/execution/tool-executor";
import { PolicyEngine } from "../../../src/core/policy";

/**
 * What the executor hands a `tool.native.pre` policy. Half of what the
 * tool-permission integration suite used to prove lived here and not in the
 * policy: a permission ruleset can only match on labels and a canonical name
 * if the executor puts them in the context. How a ruleset then *interprets*
 * them is the policy's, and moved to openomni with it (#629).
 */
function observingEngine(seen: Policy.PolicyDecision[] | Array<Record<string, unknown>>) {
  const engine = PolicyEngine.create();
  engine.register({
    kind: "point",
    name: "test:tool-pre-observer",
    pointIds: ["tool.native.pre"],
    effectCapabilities: { "tool.native.pre": [] },
    priority: 0,
    fn: (ctx) => {
      (seen as Array<Record<string, unknown>>).push({
        toolName: ctx.toolName,
        toolLabels: ctx.toolLabels,
      });
      return PolicyDecision.allow({ policyId: "test.tool-pre-observer" });
    },
  });
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
