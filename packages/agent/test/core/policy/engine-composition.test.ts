import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext, PolicyRegistration } from "../../../src/core/policy/types";

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

describe("deny-wins composition", () => {
  it("deny verdict takes precedence over prior continue verdicts", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "allow-policy-a",
      timing: "turn.start",
      priority: 10,
      fn: () => ({ action: "continue" }),
    });
    engine.register({
      name: "allow-policy-b",
      timing: "turn.start",
      priority: 20,
      fn: () => ({ action: "continue" }),
    });
    engine.register({
      name: "deny-policy",
      timing: "turn.start",
      priority: 30,
      fn: () => ({ action: "deny", reason: "blocked-by-deny", policyId: "test.deny" }),
    });

    const verdict = await engine.dispatch("turn.start", baseCtx());

    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toBe("blocked-by-deny");
  });

  it("deny at lower priority short-circuits higher priority policies", async () => {
    const executed: string[] = [];
    const engine = PolicyEngine.create();

    engine.register({
      name: "deny-first",
      timing: "invoke.prepare",
      priority: 0,
      fn: () => {
        executed.push("deny-first");
        return { action: "deny", reason: "early-deny", policyId: "test.deny-first" };
      },
    });
    engine.register({
      name: "allow-later",
      timing: "invoke.prepare",
      priority: 100,
      fn: () => {
        executed.push("allow-later");
        return { action: "continue" };
      },
    });
    engine.register({
      name: "transform-later",
      timing: "invoke.prepare",
      priority: 200,
      fn: () => {
        executed.push("transform-later");
        return { action: "transform", input: {}, reason: "transform", policyId: "test.transform" };
      },
    });

    const verdict = await engine.dispatch("invoke.prepare", baseCtx());

    expect(verdict.action).toBe("deny");
    expect(executed).toEqual(["deny-first"]);
  });

  it("abort also short-circuits continue policies", async () => {
    const executed: string[] = [];
    const engine = PolicyEngine.create();

    engine.register({
      name: "allow-first",
      timing: "turn.finish",
      priority: 10,
      fn: () => {
        executed.push("allow-first");
        return { action: "continue" };
      },
    });
    engine.register({
      name: "abort-second",
      timing: "turn.finish",
      priority: 20,
      fn: () => {
        executed.push("abort-second");
        return { action: "abort", reason: "abort-wins", policyId: "test.abort" };
      },
    });
    engine.register({
      name: "inject-third",
      timing: "turn.finish",
      priority: 30,
      fn: () => {
        executed.push("inject-third");
        return { action: "inject", message: "msg", reason: "inject", policyId: "test.inject" };
      },
    });

    const verdict = await engine.dispatch("turn.finish", baseCtx());

    expect(verdict.action).toBe("abort");
    expect(executed).toEqual(["allow-first", "abort-second"]);
  });

  it("all continue verdicts result in continue", async () => {
    const engine = PolicyEngine.create();
    for (let i = 0; i < 5; i++) {
      engine.register({
        name: `continue-${i}`,
        timing: "run.start",
        priority: i * 10,
        fn: () => ({ action: "continue" }),
      });
    }

    const verdict = await engine.dispatch("run.start", baseCtx());
    expect(verdict.action).toBe("continue");
  });

  it("deny-wins across all Policy.Timing values", async () => {
    const timings: Policy.Timing[] = [
      "run.start",
      "turn.start",
      "invoke.prepare",
      "invoke.result",
      "turn.finish",
      "completion.prepare",
      "run.finish",
      "error",
      "resources.prepare",
      "invoke.prepare",
    ];

    for (const timing of timings) {
      const engine = PolicyEngine.create();
      engine.register({
        name: "allow",
        timing,
        priority: 0,
        fn: () => ({ action: "continue" }),
      });
      engine.register({
        name: "deny",
        timing,
        priority: 10,
        fn: () => ({ action: "deny", reason: `denied-at-${timing}`, policyId: "test.deny" }),
      });

      const verdict = await engine.dispatch(timing, baseCtx());
      expect(verdict.action).toBe("deny");
      expect(verdict.reason).toBe(`denied-at-${timing}`);
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
      const agentType = agentTypes[i % agentTypes.length]!;
      const reg: PolicyRegistration = {
        name: `policy-${i}-${agentType}`,
        timing: "turn.start",
        priority: i,
        scope: { agentType: [agentType] },
        fn: () => {
          executed.push(`policy-${i}-${agentType}`);
          return { action: "continue" };
        },
      };
      engine.register(reg);
    }

    await engine.dispatch("turn.start", { ...baseCtx(), agentType: "coder" });

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
        name: `scoped-reviewer-${i}`,
        timing: "invoke.prepare",
        priority: i * 2,
        scope: { agentType: ["reviewer"] },
        fn: () => {
          executed.push(`scoped-reviewer-${i}`);
          return { action: "continue" };
        },
      });
    }

    for (let i = 0; i < 50; i++) {
      engine.register({
        name: `unscoped-${i}`,
        timing: "invoke.prepare",
        priority: i * 2 + 1,
        fn: () => {
          executed.push(`unscoped-${i}`);
          return { action: "continue" };
        },
      });
    }

    await engine.dispatch("invoke.prepare", { ...baseCtx(), agentType: "reviewer" });

    expect(executed.length).toBe(100);

    executed.length = 0;
    await engine.dispatch("invoke.prepare", { ...baseCtx(), agentType: "coder" });

    expect(executed.length).toBe(50);
    expect(executed.every((name) => name.startsWith("unscoped-"))).toBe(true);
  });

  it("no agentType in context skips all scoped policies", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    for (let i = 0; i < 80; i++) {
      engine.register({
        name: `scoped-${i}`,
        timing: "turn.finish",
        priority: i,
        scope: { agentType: ["planner", "architect"] },
        fn: () => {
          executed.push(`scoped-${i}`);
          return { action: "continue" };
        },
      });
    }

    for (let i = 0; i < 20; i++) {
      engine.register({
        name: `unscoped-${i}`,
        timing: "turn.finish",
        priority: 100 + i,
        fn: () => {
          executed.push(`unscoped-${i}`);
          return { action: "continue" };
        },
      });
    }

    await engine.dispatch("turn.finish", baseCtx());

    expect(executed.length).toBe(20);
    expect(executed.every((name) => name.startsWith("unscoped-"))).toBe(true);
  });

  it("scope filtering with multi-agent scope arrays", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    for (let i = 0; i < 100; i++) {
      const scopeTypes = i % 3 === 0 ? ["coder", "reviewer"] : i % 3 === 1 ? ["planner"] : ["ops"];
      engine.register({
        name: `policy-${i}`,
        timing: "error",
        priority: i,
        scope: { agentType: scopeTypes },
        fn: () => {
          executed.push(`policy-${i}`);
          return { action: "continue" };
        },
      });
    }

    await engine.dispatch("error", { ...baseCtx(), agentType: "reviewer" });

    const expectedCount = Math.ceil(100 / 3);
    expect(executed.length).toBe(expectedCount);
    expect(
      executed.every((name) => {
        const idx = Number.parseInt(name.split("-")[1]!);
        return idx % 3 === 0;
      }),
    ).toBe(true);
  });
});
