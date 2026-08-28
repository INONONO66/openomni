import { describe, expect, it } from "bun:test";
import { PolicyDecision, type Tool } from "@openomni/protocol";
import {
  PolicyEngine,
  type CanonicalPolicyRegistrationGeneric,
  type GenericPolicyContext,
} from "@openomni/policy";
import { allow, atPoint, toolPreContext, turnPostContext, turnPreContext } from "./point-test-fixtures";

const deny = (policyId: string, reason: string) =>
  PolicyDecision.deny({
    policyId,
    reasonCodes: [reason],
    effects: [{ type: "audit.annotate", annotation: reason, severity: "error" }],
  });
const policyContext = () => ({});
type PolicyRegistration = CanonicalPolicyRegistrationGeneric<GenericPolicyContext>;

describe("deny-wins point matrix", () => {
  it("deny-wins across all registered policy points", async () => {
    // Canonical successors of the legacy Policy.Timing values (invoke.prepare /
    // invoke.result exercised through their tool.native representatives),
    // each dispatched with the point contract's required inputs. The interim
    // session.inbound.pre / session.writeback.pre points were removed from the
    // registry with the ingress policy gate (#578).
    const pointCases = [
      {
        pointId: "run.lifecycle.pre",
        ctx: { actorId: "actor", sessionId: "session", runId: "run" },
      },
      { pointId: "run.turn.pre", ctx: { sessionId: "session", runId: "run", turnIndex: 0 } },
      { pointId: "prompt.context.pre", ctx: { sessionId: "session", runId: "run", turnIndex: 0 } },
      {
        pointId: "tool.catalog.pre",
        ctx: { sessionId: "session", runId: "run", availableTools: [] as Tool.Spec[] },
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

      const verdict = await engine.dispatchPoint(pointId, { ...policyContext(), ...ctx });
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

    await engine.dispatchPoint("run.turn.pre", { ...turnPreContext(), agentType: "coder" });

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
      engine.register(
        atPoint("tool.native.pre", {
          name: `scoped-reviewer-${i}`,
          priority: i * 2,
          scope: { agentType: ["reviewer"] },
          fn: () => {
            executed.push(`scoped-reviewer-${i}`);
            return allow();
          },
        }),
      );
    }

    for (let i = 0; i < 50; i++) {
      engine.register(
        atPoint("tool.native.pre", {
          name: `unscoped-${i}`,
          priority: i * 2 + 1,
          fn: () => {
            executed.push(`unscoped-${i}`);
            return allow();
          },
        }),
      );
    }

    await engine.dispatchPoint("tool.native.pre", { ...toolPreContext(), agentType: "reviewer" });

    expect(executed.length).toBe(100);

    executed.length = 0;
    await engine.dispatchPoint("tool.native.pre", { ...toolPreContext(), agentType: "coder" });

    expect(executed.length).toBe(50);
    expect(executed.every((name) => name.startsWith("unscoped-"))).toBe(true);
  });

  it("no agentType in context skips all scoped policies", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];
    let scopedInvocations = 0;

    for (let i = 0; i < 80; i++) {
      engine.register(
        atPoint("run.turn.post", {
          name: `scoped-${i}`,
          priority: i,
          scope: { agentType: ["planner", "architect"] },
          fn: () => {
            scopedInvocations += 1;
            executed.push(`scoped-${i}`);
            throw new Error("a scope-skipped policy must remain outside composition");
          },
        }),
      );
    }

    for (let i = 0; i < 20; i++) {
      engine.register(
        atPoint("run.turn.post", {
          name: `unscoped-${i}`,
          priority: 100 + i,
          fn: () => {
            executed.push(`unscoped-${i}`);
            return allow();
          },
        }),
      );
    }

    const decision = await engine.dispatchPoint("run.turn.post", turnPostContext());

    // #806 containment: omission excludes the entire scoped registration;
    // unscoped policies still run, and no skipped crash evidence can leak.
    expect(scopedInvocations).toBe(0);
    expect(executed.length).toBe(20);
    expect(executed.every((name) => name.startsWith("unscoped-"))).toBe(true);
    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toEqual([]);
    expect(decision.effects).toEqual([]);
  });

  it("scope filtering with multi-agent scope arrays", async () => {
    const engine = PolicyEngine.create();
    const executed: string[] = [];

    for (let i = 0; i < 100; i++) {
      const scopeTypes = i % 3 === 0 ? ["coder", "reviewer"] : i % 3 === 1 ? ["planner"] : ["ops"];
      engine.register(
        atPoint("run.error.error", {
          name: `policy-${i}`,
          priority: i,
          scope: { agentType: scopeTypes },
          fn: () => {
            executed.push(`policy-${i}`);
            return allow();
          },
        }),
      );
    }

    await engine.dispatchPoint("run.error.error", {
      ...policyContext(),
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
