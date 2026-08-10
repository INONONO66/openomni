import { describe, expect, it } from "bun:test";
import {
  Operational,
  PolicyDecision,
  ToolExecution,
  type Policy,
  type Tool,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { createToolExecutor } from "../../../src/core/execution/tool-executor";
import { PolicyEngine, type PolicyRegistration } from "../../../src/core/policy";

type ResultWithMetadata = Tool.Result & {
  metadata?: {
    verdict?: string;
    reason?: string;
    retryAfterMs?: number;
  };
};

function makeCall(id = "call-1"): Tool.Call {
  return { id, tool: "bash", input: { command: "bun test" } };
}

function verdictPolicy(decision: Policy.PolicyDecision): PolicyRegistration {
  return {
    kind: "point",
    name: `test-${decision.verdict}`,
    pointIds: ["tool.native.pre"],
    effectCapabilities: {
      "tool.native.pre": [...new Set(decision.effects.map((effect) => effect.type))],
    },
    priority: 0,
    fn: async () => decision,
  };
}

function engineWith(decision: Policy.PolicyDecision) {
  const engine = PolicyEngine.create();
  engine.register(verdictPolicy(decision));
  return engine;
}

function engineWithRegistrations(registrations: PolicyRegistration[]) {
  const engine = PolicyEngine.create();
  for (const registration of registrations) engine.register(registration);
  return engine;
}

async function flushBus(): Promise<void> {
  await Promise.resolve();
}

describe("createToolExecutor invoke.prepare verdict handling", () => {
  it("blocks tool execution when policy returns deny", async () => {
    Bus.reset();
    let calls = 0;
    const denied: unknown[] = [];
    const started: unknown[] = [];
    Bus.subscribe(ToolExecution.PermissionDenied, (event) => denied.push(event));
    Bus.subscribe(ToolExecution.Started, (event) => started.push(event));

    const engine = engineWith(
      PolicyDecision.deny({
        policyId: "test.deny",
        reasonCodes: ["sandbox_violation"],
        effects: [{ type: "run.abort", reason: "sandbox_violation" }],
      }),
    );
    const executor = createToolExecutor({
      engine,
      traceContext: { traceId: "trace-deny", sessionId: "sess-deny" },
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-deny", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor(makeCall("call-deny"));
    await flushBus();

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("[Denied: sandbox_violation]");
    expect(started).toHaveLength(0);
    expect(denied).toHaveLength(1);
    expect((denied[0] as { reason: string; toolCallId: string }).reason).toBe("sandbox_violation");
  });

  it("fails closed when invoke.prepare returns pending approval", async () => {
    let calls = 0;
    const engine = engineWith(
      PolicyDecision.pending({
        policyId: "test.approval",
        reasonCodes: ["wrong_boundary"],
        effects: [{ type: "tool.require_approval", reason: "wrong_boundary" }],
      }),
    );
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-inject", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor(makeCall("call-inject"));

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("[Denied: wrong_boundary]");
  });

  it("blocks execution with retry-after metadata when policy returns retry", async () => {
    let calls = 0;
    const engine = engineWith(
      PolicyDecision.pending({
        policyId: "test.retry",
        reasonCodes: ["rate_limited"],
        effects: [{ type: "tool.require_approval", reason: "rate_limited" }],
      }),
    );
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-retry", toolCallId: call.id, output: "should not run" };
      },
    });

    const result: ResultWithMetadata = await executor(makeCall("call-retry"));

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("[Denied: rate_limited]");
    expect(result.metadata).toEqual({
      verdict: "pending",
      reason: "rate_limited",
      policyId: "agent.policy.composed",
    });
  });

  it("preserves deny blocking behavior", async () => {
    let calls = 0;
    const skipEngine = engineWith(
      PolicyDecision.deny({
        policyId: "test.skip",
        reasonCodes: ["optional"],
        effects: [{ type: "run.abort", reason: "optional" }],
      }),
    );
    const skipExecutor = createToolExecutor({
      engine: skipEngine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-skip", toolCallId: call.id, output: "should not run" };
      },
    });

    const skipResult = await skipExecutor(makeCall("call-skip"));
    expect(skipResult).toMatchObject({
      toolCallId: "call-skip",
      output: "[Denied: optional]",
      isError: true,
    });

    const abortEngine = engineWith(
      PolicyDecision.deny({
        policyId: "test.abort",
        reasonCodes: ["Blocked: hard stop"],
        effects: [{ type: "run.abort", reason: "Blocked: hard stop" }],
      }),
    );
    const abortExecutor = createToolExecutor({
      engine: abortEngine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-abort", toolCallId: call.id, output: "should not run" };
      },
    });

    const abortResult = await abortExecutor(makeCall("call-abort"));
    expect(abortResult).toMatchObject({
      toolCallId: "call-abort",
      output: "[Denied: Blocked: hard stop]",
      isError: true,
    });
    expect(calls).toBe(0);
  });
});

describe("createToolExecutor effect application", () => {
  it("blocks matching tool.filter effects at invoke.prepare", async () => {
    let calls = 0;
    const engine = engineWith(
      PolicyDecision.allow({
        policyId: "test.filter",
        reasonCodes: ["filtered_tool"],
        effects: [{ type: "tool.filter", toolPattern: "bash" }],
      }),
    );
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-filter", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor(makeCall("call-filtered"));

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      toolCallId: "call-filtered",
      output: "[Denied: filtered_tool]",
      isError: true,
    });
  });

  it("allows non-matching tool.filter effects at invoke.prepare", async () => {
    let calls = 0;
    const engine = engineWith(
      PolicyDecision.allow({
        policyId: "test.filter",
        reasonCodes: ["filter-other"],
        effects: [{ type: "tool.filter", toolPattern: "dangerous.*" }],
      }),
    );
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-filter-miss", toolCallId: call.id, output: "ok" };
      },
    });

    const result = await executor(makeCall("call-filter-miss"));

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      toolCallId: "call-filter-miss",
      output: "ok",
    });
  });

  it("skips native tool invocation when invoke.prepare returns tool.skip_invocation", async () => {
    let calls = 0;
    const engine = engineWith(
      PolicyDecision.allow({
        policyId: "test.skip",
        reasonCodes: ["optional"],
        effects: [{ type: "tool.skip_invocation", reason: "cached" }],
      }),
    );
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-skip", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor(makeCall("call-real-skip"));

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      toolCallId: "call-real-skip",
      output: "[Skipped: cached]",
      isError: false,
    });
  });

  it("rewrites native tool input before invocation", async () => {
    let seenInput: Record<string, unknown> | undefined;
    const engine = engineWith(
      PolicyDecision.allow({
        policyId: "test.rewrite-input",
        reasonCodes: ["rewrite"],
        effects: [{ type: "tool.rewrite_input", input: { command: "echo safe" } }],
      }),
    );
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => {
        seenInput = call.input;
        return { id: "result-rewrite", toolCallId: call.id, output: "ok" };
      },
    });

    const result = await executor(makeCall("call-rewrite-input"));

    expect(result.output).toBe("ok");
    expect(seenInput).toEqual({ command: "echo safe" });
  });

  it("rewrites native tool output after successful invocation", async () => {
    const engine = engineWithRegistrations([
      {
        kind: "point",
        name: "pre",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": [] },
        priority: 0,
        fn: () => PolicyDecision.allow({ policyId: "pre" }),
      },
      {
        kind: "point",
        name: "post",
        pointIds: ["tool.native.post"],
        effectCapabilities: { "tool.native.post": ["tool.rewrite_output"] },
        priority: 0,
        fn: () =>
          PolicyDecision.allow({
            policyId: "post",
            reasonCodes: ["redact"],
            effects: [{ type: "tool.rewrite_output", output: "redacted" }],
          }),
      },
    ]);
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => ({
        id: "result-output",
        toolCallId: call.id,
        output: "secret",
      }),
    });

    const result = await executor(makeCall("call-rewrite-output"));

    expect(result.output).toBe("redacted");
  });

  it("keeps post-boundary plain deny diagnostic-only without leaking rewrite effects", async () => {
    const engine = engineWithRegistrations([
      {
        kind: "point",
        name: "pre",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": [] },
        priority: 0,
        fn: () => PolicyDecision.allow({ policyId: "pre" }),
      },
      {
        kind: "point",
        name: "post",
        pointIds: ["tool.native.post"],
        effectCapabilities: { "tool.native.post": ["audit.annotate"] },
        priority: 0,
        fn: () =>
          PolicyDecision.deny({
            policyId: "post",
            reasonCodes: ["post-deny"],
            effects: [{ type: "audit.annotate", annotation: "post-deny" }],
          }),
      },
    ]);
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => ({
        id: "result-plain-post",
        toolCallId: call.id,
        output: "original",
      }),
    });

    const result = await executor(makeCall("call-plain-post-deny"));

    expect(result.output).toBe("original");
    expect(result.isError).toBeUndefined();
  });

  it("blocks and redacts output when invoke.result returns deny with explicit run.abort", async () => {
    const engine = engineWithRegistrations([
      {
        kind: "point",
        name: "pre",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": [] },
        priority: 0,
        fn: () => PolicyDecision.allow({ policyId: "pre" }),
      },
      {
        kind: "point",
        name: "post",
        pointIds: ["tool.native.post"],
        effectCapabilities: { "tool.native.post": ["run.abort", "tool.rewrite_output"] },
        priority: 0,
        fn: () =>
          PolicyDecision.deny({
            policyId: "post",
            reasonCodes: ["post-deny"],
            effects: [
              { type: "run.abort", reason: "post-deny" },
              { type: "tool.rewrite_output", output: "should-not-apply" },
            ],
          }),
      },
    ]);
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => ({
        id: "result-denied-post",
        toolCallId: call.id,
        output: "original",
      }),
    });

    const result = await executor(makeCall("call-post-deny"));

    expect(result.output).toBe("[Denied: post-deny]");
    expect(result.isError).toBe(true);
  });

  it("classifies source.mcp labelled tools as MCP resources", async () => {
    const capturedSources: Array<string | undefined> = [];
    const engine = engineWithRegistrations([
      {
        kind: "point",
        name: "capture-mcp",
        pointIds: ["tool.mcp.pre"],
        effectCapabilities: { "tool.mcp.pre": [] },
        priority: 0,
        fn: (ctx) => {
          const resourceDescriptor = ctx as {
            resourceDescriptor?: { source?: { type?: string } };
          };
          capturedSources.push(resourceDescriptor.resourceDescriptor?.source?.type);
          return PolicyDecision.allow({ policyId: "capture-mcp" });
        },
      },
    ]);
    const executor = createToolExecutor({
      engine,
      getToolLabels: () => ["source.mcp", "mcp.fixture"],
      toolExecutor: async (call) => ({ id: "result-mcp", toolCallId: call.id, output: "mcp ok" }),
    });

    await executor({ id: "mcp-call", tool: "fixture_read", input: {} });

    expect(capturedSources).toEqual(["mcp"]);
  });

  describe("invoke.result run.abort propagation", () => {
    it("invoke.result deny with run.abort returns blocked result", async () => {
      let calls = 0;
      const decision = PolicyDecision.deny({
        policyId: "post",
        reasonCodes: ["post-deny"],
        effects: [{ type: "run.abort", reason: "post-deny" }],
      });
      const engine = engineWithRegistrations([
        {
          kind: "point",
          name: "pre",
          pointIds: ["tool.native.pre"],
          effectCapabilities: { "tool.native.pre": [] },
          priority: 0,
          fn: () => PolicyDecision.allow({ policyId: "pre" }),
        },
        {
          kind: "point",
          name: "post",
          pointIds: ["tool.native.post"],
          effectCapabilities: { "tool.native.post": ["run.abort"] },
          priority: 0,
          fn: () => decision,
        },
      ]);
      const executor = createToolExecutor({
        engine,
        toolExecutor: async (call) => {
          calls += 1;
          return {
            id: "result-post-abort",
            toolCallId: call.id,
            output: "original",
          };
        },
      });

      const result = await executor(makeCall("call-post-abort"));

      expect(calls).toBeGreaterThan(0);
      expect(result.isError).toBe(true);
      expect(result.output).toBe("[Denied: post-deny]");
    });

    it("invoke.result deny without run.abort still returns tool result", async () => {
      let calls = 0;
      const engine = engineWithRegistrations([
        {
          kind: "point",
          name: "pre",
          pointIds: ["tool.native.pre"],
          effectCapabilities: { "tool.native.pre": [] },
          priority: 0,
          fn: () => PolicyDecision.allow({ policyId: "pre" }),
        },
        {
          kind: "point",
          name: "post",
          pointIds: ["tool.native.post"],
          effectCapabilities: { "tool.native.post": ["audit.annotate"] },
          priority: 0,
          fn: () =>
            PolicyDecision.deny({
              policyId: "post",
              reasonCodes: ["post-deny"],
              effects: [{ type: "audit.annotate", annotation: "post-deny" }],
            }),
        },
      ]);
      const executor = createToolExecutor({
        engine,
        toolExecutor: async (call) => {
          calls += 1;
          return {
            id: "result-post-audit",
            toolCallId: call.id,
            output: "original",
          };
        },
      });

      const result = await executor(makeCall("call-post-audit"));

      expect(calls).toBeGreaterThan(0);
      expect(result.isError).toBeUndefined();
      expect(result.output).toBe("original");
    });

    it("onDecision callback receives invoke.result decisions", async () => {
      const decisions: Array<[string, Policy.PolicyDecision]> = [];
      const decision = PolicyDecision.deny({
        policyId: "post",
        reasonCodes: ["post-deny"],
        effects: [{ type: "run.abort", reason: "post-deny" }],
      });
      const engine = engineWithRegistrations([
        {
          kind: "point",
          name: "pre",
          pointIds: ["tool.native.pre"],
          effectCapabilities: { "tool.native.pre": [] },
          priority: 0,
          fn: () => PolicyDecision.allow({ policyId: "pre" }),
        },
        {
          kind: "point",
          name: "post",
          pointIds: ["tool.native.post"],
          effectCapabilities: { "tool.native.post": ["run.abort"] },
          priority: 0,
          fn: () => decision,
        },
      ]);
      const executor = createToolExecutor({
        engine,
        onDecision: (timing, decision) => {
          decisions.push([timing, decision]);
        },
        toolExecutor: async (call) => ({
          id: "result-on-decision",
          toolCallId: call.id,
          output: "original",
        }),
      });

      await executor(makeCall("call-on-decision"));

      const invokeResultDecision = decisions.find(([timing]) => timing === "invoke.result");
      expect(invokeResultDecision).toBeDefined();
      expect(invokeResultDecision?.[1].verdict).toBe("deny");
      expect(invokeResultDecision?.[1].reasonCodes).toContain("post-deny");
    });

    it("isolates onDecision callback errors from tool execution", async () => {
      Bus.reset();
      const warnings: unknown[] = [];
      const unsubscribe = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));
      const engine = engineWithRegistrations([
        {
          kind: "point",
          name: "pre",
          pointIds: ["tool.native.pre"],
          effectCapabilities: { "tool.native.pre": [] },
          priority: 0,
          fn: () => PolicyDecision.allow({ policyId: "pre" }),
        },
      ]);
      const executor = createToolExecutor({
        engine,
        onDecision: () => {
          throw new Error("observer failed");
        },
        toolExecutor: async (call) => ({
          id: "result-on-decision-error",
          toolCallId: call.id,
          output: "ok",
        }),
      });

      try {
        const result = await executor(makeCall("call-on-decision-error"));
        await new Promise((resolve) => queueMicrotask(resolve));

        expect(result.output).toBe("ok");
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toMatchObject({
          component: "agent.tool-executor",
          msg: "onDecision observer error",
          context: {
            timing: "invoke.prepare",
            policyId: "agent.policy.composed",
            error: "Error: observer failed",
          },
        });
        expect(warnings[1]).toMatchObject({
          component: "agent.tool-executor",
          msg: "onDecision observer error",
          context: {
            timing: "invoke.result",
            policyId: "agent.policy.composed",
            error: "Error: observer failed",
          },
        });
      } finally {
        unsubscribe();
        Bus.reset();
      }
    });

    it("isolates async onDecision callback rejections from tool execution", async () => {
      Bus.reset();
      const warnings: unknown[] = [];
      const unsubscribe = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));
      const engine = engineWithRegistrations([
        {
          kind: "point",
          name: "pre",
          pointIds: ["tool.native.pre"],
          effectCapabilities: { "tool.native.pre": [] },
          priority: 0,
          fn: () => PolicyDecision.allow({ policyId: "pre" }),
        },
      ]);
      const executor = createToolExecutor({
        engine,
        onDecision: async () => {
          throw new Error("async observer failed");
        },
        toolExecutor: async (call) => ({
          id: "result-async-on-decision-error",
          toolCallId: call.id,
          output: "ok",
        }),
      });

      try {
        const result = await executor(makeCall("call-async-on-decision-error"));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.output).toBe("ok");
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toMatchObject({
          component: "agent.tool-executor",
          msg: "onDecision observer error",
          context: {
            timing: "invoke.prepare",
            policyId: "agent.policy.composed",
            error: "Error: async observer failed",
          },
        });
        expect(warnings[1]).toMatchObject({
          component: "agent.tool-executor",
          msg: "onDecision observer error",
          context: {
            timing: "invoke.result",
            policyId: "agent.policy.composed",
            error: "Error: async observer failed",
          },
        });
      } finally {
        unsubscribe();
        Bus.reset();
      }
    });
  });
});
