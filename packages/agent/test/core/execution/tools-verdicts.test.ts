import { describe, expect, it } from "bun:test";
import { Operational, PolicyDecision, Tool, type Policy } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { matchesToolPattern } from "../../../src/core/execution/effects";
import { createToolExecutor, type BlockedToolResult } from "../../../src/core/execution/tools";
import { PolicyEngine, type PolicyRegistration } from "../../../src/core/policy";
import { captureBusEvents } from "../../helpers/bus-event";

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
    fn: () => decision,
  };
}

function engineWith(decision: Policy.PolicyDecision) {
  const engine = PolicyEngine.create({ clock: Date.now });
  engine.register(verdictPolicy(decision));
  return engine;
}

function engineWithRegistrations(registrations: PolicyRegistration[]) {
  const engine = PolicyEngine.create({ clock: Date.now });
  for (const registration of registrations) engine.register(registration);
  return engine;
}

describe("createToolExecutor invoke.prepare verdict handling", () => {
  it("blocks tool execution when policy returns deny", async () => {
    Bus.reset();
    let calls = 0;
    const denied: unknown[] = [];
    const started: unknown[] = [];
    Bus.subscribe(Tool.Events.PermissionDenied, (event) => denied.push(event));
    Bus.subscribe(Tool.Events.Started, (event) => started.push(event));

    const engine = engineWith(
      PolicyDecision.deny({
        policyId: "test.deny",
        reasonCodes: ["sandbox_violation"],
        effects: [{ type: "run.abort", reason: "sandbox_violation" }],
      }),
    );
    const executor = createToolExecutor({
      events: Bus,
      engine,
      traceContext: { traceId: "trace-deny", sessionId: "sess-deny", runId: "run-1" },
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-deny", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor(makeCall("call-deny"));

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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-inject", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor(makeCall("call-inject"));

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    // Audit M5: no approval flow is wired anywhere, so a require_approval
    // verdict is a fail-closed denial and the output must say so instead of
    // implying an approval was requested.
    expect(result.output).toBe(
      "[Denied: wrong_boundary — approval required, but no approval flow is wired; denied fail-closed]",
    );
  });

  it("blocks execution with verdict metadata when policy returns pending", async () => {
    let calls = 0;
    const engine = engineWith(
      PolicyDecision.pending({
        policyId: "test.retry",
        reasonCodes: ["rate_limited"],
        effects: [{ type: "tool.require_approval", reason: "rate_limited" }],
      }),
    );
    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-retry", toolCallId: call.id, output: "should not run" };
      },
    });

    const result: BlockedToolResult = await executor(makeCall("call-retry"));

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      "[Denied: rate_limited — approval required, but no approval flow is wired; denied fail-closed]",
    );
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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

  it("a wildcard filter stops at the dot boundary — shell.* never blocks shellfish (#606)", () => {
    expect(matchesToolPattern("shell.exec", "shell.*")).toBe(true);
    expect(matchesToolPattern("shellfish", "shell.*")).toBe(false);
    expect(matchesToolPattern("shell", "shell.*")).toBe(false);
    expect(matchesToolPattern("shell.exec", "shell")).toBe(false);
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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

  it("classifies source:mcp labelled tools as MCP resources", async () => {
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
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      engine,
      getToolLabels: () => ["source:mcp", "mcp.fixture"],
      toolExecutor: async (call) => ({ id: "result-mcp", toolCallId: call.id, output: "mcp ok" }),
    });

    await executor({ id: "mcp-call", tool: "fixture_read", input: {} });

    expect(capturedSources).toEqual(["mcp"]);
  });

  it("denies a tool.mcp.pre with an absent mcpServerId (context_missing, fail-closed)", async () => {
    // Pins the invariant the narrowed `& { mcpServerId: string }` cast in
    // dispatchToolPre relies on: an mcp target with no resolvable server id
    // (source:mcp label but no `mcp.<id>` label) omits mcpServerId, so the
    // fail-closed tool.mcp.pre contract denies via context_missing BEFORE the
    // tool runs — never a silent allow.
    let invoked = 0;
    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      engine: PolicyEngine.create({ clock: Date.now }),
      getToolLabels: () => ["source:mcp"],
      toolExecutor: async (call) => {
        invoked += 1;
        return { id: "r", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor({ id: "mcp-no-server", tool: "fixture_read", input: {} });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("[Denied:");
    expect(invoked).toBe(0);
  });

  describe("invoke.result run.abort propagation", () => {
    it.each([
      {
        name: "with run.abort returns blocked result",
        capability: "run.abort",
        effect: { type: "run.abort", reason: "post-deny" },
        expectedError: true,
        expectedOutput: "[Denied: post-deny]",
      },
      {
        name: "without run.abort still returns tool result",
        capability: "audit.annotate",
        effect: { type: "audit.annotate", annotation: "post-deny" },
        expectedError: undefined,
        expectedOutput: "original",
      },
    ] as const)("invoke.result deny $name", async ({
      capability,
      effect,
      expectedError,
      expectedOutput,
    }) => {
      let calls = 0;
      const decision = PolicyDecision.deny({
        policyId: "post",
        reasonCodes: ["post-deny"],
        effects: [effect],
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
          effectCapabilities: { "tool.native.post": [capability] },
          priority: 0,
          fn: () => decision,
        },
      ]);
      const executor = createToolExecutor({
        events: Bus,
        traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
        engine,
        toolExecutor: async (call) => {
          calls += 1;
          return { id: "result-post-deny", toolCallId: call.id, output: "original" };
        },
      });

      const result = await executor(makeCall("call-post-deny"));

      expect(calls).toBeGreaterThan(0);
      expect(result.isError).toBe(expectedError);
      expect(result.output).toBe(expectedOutput);
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
        events: Bus,
        traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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

    it.each([
      {
        name: "callback errors",
        error: "observer failed",
        onDecision: () => {
          throw new Error("observer failed");
        },
      },
      {
        name: "async callback rejections",
        error: "async observer failed",
        onDecision: async () => {
          throw new Error("async observer failed");
        },
      },
    ] as const)("isolates onDecision $name from tool execution", async ({ error, onDecision }) => {
      Bus.reset();
      const warnings = captureBusEvents(Operational.Events.Warn, 2);
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
        events: Bus,
        traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
        engine,
        onDecision,
        toolExecutor: async (call) => ({
          id: "result-on-decision-error",
          toolCallId: call.id,
          output: "ok",
        }),
      });

      try {
        const result = await executor(makeCall("call-on-decision-error"));
        const [prepareWarning, resultWarning] = await warnings.done;

        expect(result.output).toBe("ok");
        expect(prepareWarning).toMatchObject({
          component: "agent.tool-executor",
          msg: "onDecision observer error",
          context: {
            timing: "invoke.prepare",
            policyId: "agent.policy.composed",
            error: `Error: ${error}`,
          },
        });
        expect(resultWarning).toMatchObject({
          component: "agent.tool-executor",
          msg: "onDecision observer error",
          context: {
            timing: "invoke.result",
            policyId: "agent.policy.composed",
            error: `Error: ${error}`,
          },
        });
      } finally {
        warnings.unsubscribe();
        Bus.reset();
      }
    });
  });
});
