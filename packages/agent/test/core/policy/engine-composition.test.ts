import { describe, expect, it } from "bun:test";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext, PolicyRegistration } from "../../../src/core/policy/types";
import { abortRun, allow, deny, inject, rewriteToolInput } from "../../helpers/policy-decision";

function baseCtx(): Omit<PolicyContext, "timing"> {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

/** Required inputs for the run.turn.pre point contract. */
function turnPreCtx() {
  return { ...baseCtx(), sessionId: "session", runId: "run", turnIndex: 0 };
}

/** Required inputs for the run.turn.post point contract. */
function turnPostCtx() {
  return {
    ...baseCtx(),
    sessionId: "session",
    runId: "run",
    turnIndex: 0,
    turnResult: { type: "stop" },
  };
}

/** Required inputs for the tool.native.pre point contract. */
function toolPreCtx() {
  return {
    ...baseCtx(),
    sessionId: "session",
    runId: "run",
    toolId: "tool:native:test",
    toolInput: {},
  };
}

describe("deny-wins composition", () => {
  it("deny verdict takes precedence over prior continue verdicts", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "allow-policy-a",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 10,
      fn: () => allow(),
    });
    engine.register({
      kind: "point",
      name: "allow-policy-b",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": [] },
      priority: 20,
      fn: () => allow(),
    });
    engine.register({
      kind: "point",
      name: "deny-policy",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["audit.annotate"] },
      priority: 30,
      fn: () => deny("test.deny", "blocked-by-deny"),
    });

    const verdict = await engine.dispatchPoint("run.turn.pre", turnPreCtx());

    expect(verdict.verdict).toBe("deny");
    expect(verdict.reasonCodes).toContain("blocked-by-deny");
  });

  it("deny at lower priority short-circuits higher priority policies", async () => {
    const executed: string[] = [];
    const engine = PolicyEngine.create();

    engine.register({
      kind: "point",
      name: "deny-first",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["audit.annotate"] },
      priority: 0,
      fn: () => {
        executed.push("deny-first");
        return deny("test.deny-first", "early-deny");
      },
    });
    engine.register({
      kind: "point",
      name: "allow-later",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": [] },
      priority: 100,
      fn: () => {
        executed.push("allow-later");
        return allow();
      },
    });
    engine.register({
      kind: "point",
      name: "transform-later",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["tool.rewrite_input"] },
      priority: 200,
      fn: () => {
        executed.push("transform-later");
        return rewriteToolInput({}, "test.transform", "transform");
      },
    });

    const verdict = await engine.dispatchPoint("tool.native.pre", toolPreCtx());

    expect(verdict.verdict).toBe("deny");
    expect(executed).toEqual(["deny-first"]);
  });

  it("abort also short-circuits continue policies", async () => {
    const executed: string[] = [];
    const engine = PolicyEngine.create();

    engine.register({
      kind: "point",
      name: "allow-first",
      pointIds: ["run.turn.post"],
      effectCapabilities: { "run.turn.post": [] },
      priority: 10,
      fn: () => {
        executed.push("allow-first");
        return allow();
      },
    });
    engine.register({
      kind: "point",
      name: "abort-second",
      pointIds: ["run.turn.post"],
      effectCapabilities: { "run.turn.post": ["run.abort"] },
      priority: 20,
      fn: () => {
        executed.push("abort-second");
        return abortRun("test.abort", "abort-wins");
      },
    });
    engine.register({
      kind: "point",
      name: "inject-third",
      pointIds: ["run.turn.post"],
      effectCapabilities: { "run.turn.post": ["prompt.inject_message"] },
      priority: 30,
      fn: () => {
        executed.push("inject-third");
        return inject("msg", "test.inject", "inject");
      },
    });

    const verdict = await engine.dispatchPoint("run.turn.post", turnPostCtx());

    expect(verdict.verdict).toBe("deny");
    expect(executed).toEqual(["allow-first", "abort-second"]);
  });

  it("all continue verdicts result in continue", async () => {
    const engine = PolicyEngine.create();
    for (let i = 0; i < 5; i++) {
      engine.register({
        kind: "point",
        name: `continue-${i}`,
        pointIds: ["run.lifecycle.pre"],
        effectCapabilities: { "run.lifecycle.pre": [] },
        priority: i * 10,
        fn: () => allow(),
      });
    }

    const verdict = await engine.dispatchPoint("run.lifecycle.pre", {
      ...baseCtx(),
      actorId: "actor",
      sessionId: "session",
      runId: "run",
    });
    expect(verdict.verdict).toBe("allow");
  });

  it("executes equal-priority policies in registration order", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    for (const name of ["first", "second", "third"]) {
      engine.register({
        kind: "point",
        name,
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        priority: 10,
        fn: () => {
          executed.push(name);
          return allow();
        },
      });
    }

    await engine.dispatchPoint("run.turn.pre", turnPreCtx());

    expect(executed).toEqual(["first", "second", "third"]);
  });

  it("deny-wins across all registered policy points", async () => {
    // Canonical successors of the legacy Policy.Timing values (invoke.prepare /
    // invoke.result exercised through their tool.native representatives),
    // each dispatched with the point contract's required inputs.
    // session.inbound.pre / session.writeback.pre are retired from the grid
    // (#530 points disposition) and pinned in packages/policy retired-points.
    const pointCases = [
      {
        pointId: "run.lifecycle.pre",
        ctx: { actorId: "actor", sessionId: "session", runId: "run" },
      },
      { pointId: "run.turn.pre", ctx: { sessionId: "session", runId: "run", turnIndex: 0 } },
      { pointId: "prompt.context.pre", ctx: { sessionId: "session", runId: "run", turnIndex: 0 } },
      {
        pointId: "tool.catalog.pre",
        ctx: { sessionId: "session", runId: "run", availableTools: [] },
      },
      {
        pointId: "connection.llm.pre",
        ctx: { sessionId: "session", runId: "run", modelId: "model" },
      },
      {
        pointId: "connection.llm.post",
        ctx: { sessionId: "session", runId: "run", modelId: "model", responseTokens: 0 },
      },
      {
        pointId: "tool.native.pre",
        ctx: { sessionId: "session", runId: "run", toolId: "tool:native:test", toolInput: {} },
      },
      {
        pointId: "tool.native.post",
        ctx: {
          sessionId: "session",
          runId: "run",
          toolId: "tool:native:test",
          toolResult: { id: "result-1", toolCallId: "call-1", output: "ok" },
        },
      },
      {
        pointId: "run.turn.post",
        ctx: { sessionId: "session", runId: "run", turnIndex: 0, turnResult: { type: "stop" } },
      },
      {
        pointId: "run.completion.pre",
        ctx: { sessionId: "session", runId: "run", completionCandidate: { type: "stop" } },
      },
      {
        pointId: "run.lifecycle.post",
        ctx: { sessionId: "session", runId: "run", runOutcome: { type: "stop" } },
      },
      {
        pointId: "run.error.error",
        ctx: { sessionId: "session", runId: "run", errorCode: "boom", errorPhase: "turn" },
      },
    ] as const;

    for (const { pointId, ctx } of pointCases) {
      const engine = PolicyEngine.create();
      engine.register({
        kind: "point",
        name: "allow",
        pointIds: [pointId],
        effectCapabilities: { [pointId]: [] },
        priority: 0,
        fn: () => allow(),
      });
      engine.register({
        kind: "point",
        name: "deny",
        pointIds: [pointId],
        effectCapabilities: { [pointId]: ["audit.annotate"] },
        priority: 10,
        fn: () => deny("test.deny", `denied-at-${pointId}`),
      });

      const verdict = await engine.dispatchPoint(pointId, { ...baseCtx(), ...ctx });
      expect(verdict.verdict).toBe("deny");
      expect(verdict.reasonCodes).toContain(`denied-at-${pointId}`);
    }
  });
});

describe("scope filtering with 100 policies", () => {
  it("dispatches only policies matching specific agentType out of 100", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    const agentTypes = [
      "coder",
      "reviewer",
      "planner",
      "researcher",
      "writer",
      "tester",
      "debugger",
      "architect",
      "ops",
      "manager",
    ];

    for (let i = 0; i < 100; i++) {
      const agentType = agentTypes[i % agentTypes.length] ?? "unknown";
      const reg: PolicyRegistration = {
        kind: "point",
        name: `policy-${i}-${agentType}`,
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        priority: i,
        scope: { agentType: [agentType] },
        fn: () => {
          executed.push(`policy-${i}-${agentType}`);
          return allow();
        },
      };
      engine.register(reg);
    }

    await engine.dispatchPoint("run.turn.pre", { ...turnPreCtx(), agentType: "coder" });

    expect(executed.length).toBe(10);
    expect(executed.every((name) => name.includes("coder"))).toBe(true);

    const expectedIndices = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    for (const idx of expectedIndices) {
      expect(executed).toContain(`policy-${idx}-coder`);
    }
  });

  it("unscoped policies always execute alongside scoped matches", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    for (let i = 0; i < 50; i++) {
      engine.register({
        kind: "point",
        name: `scoped-reviewer-${i}`,
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": [] },
        priority: i * 2,
        scope: { agentType: ["reviewer"] },
        fn: () => {
          executed.push(`scoped-reviewer-${i}`);
          return allow();
        },
      });
    }

    for (let i = 0; i < 50; i++) {
      engine.register({
        kind: "point",
        name: `unscoped-${i}`,
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": [] },
        priority: i * 2 + 1,
        fn: () => {
          executed.push(`unscoped-${i}`);
          return allow();
        },
      });
    }

    await engine.dispatchPoint("tool.native.pre", { ...toolPreCtx(), agentType: "reviewer" });

    expect(executed.length).toBe(100);

    executed.length = 0;
    await engine.dispatchPoint("tool.native.pre", { ...toolPreCtx(), agentType: "coder" });

    expect(executed.length).toBe(50);
    expect(executed.every((name) => name.startsWith("unscoped-"))).toBe(true);
  });

  it("no agentType in context skips all scoped policies", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    for (let i = 0; i < 80; i++) {
      engine.register({
        kind: "point",
        name: `scoped-${i}`,
        pointIds: ["run.turn.post"],
        effectCapabilities: { "run.turn.post": [] },
        priority: i,
        scope: { agentType: ["planner", "architect"] },
        fn: () => {
          executed.push(`scoped-${i}`);
          return allow();
        },
      });
    }

    for (let i = 0; i < 20; i++) {
      engine.register({
        kind: "point",
        name: `unscoped-${i}`,
        pointIds: ["run.turn.post"],
        effectCapabilities: { "run.turn.post": [] },
        priority: 100 + i,
        fn: () => {
          executed.push(`unscoped-${i}`);
          return allow();
        },
      });
    }

    await engine.dispatchPoint("run.turn.post", turnPostCtx());

    expect(executed.length).toBe(20);
    expect(executed.every((name) => name.startsWith("unscoped-"))).toBe(true);
  });

  it("scope filtering with multi-agent scope arrays", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    for (let i = 0; i < 100; i++) {
      const scopeTypes = i % 3 === 0 ? ["coder", "reviewer"] : i % 3 === 1 ? ["planner"] : ["ops"];
      engine.register({
        kind: "point",
        name: `policy-${i}`,
        pointIds: ["run.error.error"],
        effectCapabilities: { "run.error.error": [] },
        priority: i,
        scope: { agentType: scopeTypes },
        fn: () => {
          executed.push(`policy-${i}`);
          return allow();
        },
      });
    }

    await engine.dispatchPoint("run.error.error", {
      ...baseCtx(),
      sessionId: "session",
      runId: "run",
      errorCode: "boom",
      errorPhase: "turn",
      agentType: "reviewer",
    });

    const expectedCount = Math.ceil(100 / 3);
    expect(executed.length).toBe(expectedCount);
    expect(
      executed.every((name) => {
        const idx = Number.parseInt(name.split("-")[1] ?? "");
        return idx % 3 === 0;
      }),
    ).toBe(true);
  });
});
