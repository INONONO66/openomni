import { describe, expect, it } from "bun:test";
import { MiddlewareEngine, type MiddlewareDecision } from "@openomni/agent";
import type { Skill } from "@openomni/protocol";
import { createSkillActivationMiddleware } from "../../src/skill";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe("createSkillActivationMiddleware", () => {
  it("injects skill prompt fragments in execution, enhancement, guarantee order", async () => {
    const engine = MiddlewareEngine.create({ audit: false });
    engine.register(
      createSkillActivationMiddleware([
        skill("guard", "guarantee", "Guarantee behavior"),
        skill("zeta", "enhancement", "Zeta enhancement"),
        skill("exec", "execution", "Execution behavior"),
        skill("alpha", "enhancement", "Alpha enhancement"),
      ]),
    );

    const result = await engine.dispatchSystemPrompt(baseCtx());
    const context = result.appendContext ?? "";

    expect(context.indexOf("[execution:exec]")).toBeLessThan(
      context.indexOf("[enhancement:alpha]"),
    );
    expect(context.indexOf("[enhancement:alpha]")).toBeLessThan(
      context.indexOf("[enhancement:zeta]"),
    );
    expect(context.indexOf("[enhancement:zeta]")).toBeLessThan(
      context.indexOf("[guarantee:guard]"),
    );
    expect(context).toContain("Execution behavior");
    expect(context).toContain("Alpha enhancement");
    expect(context).toContain("Guarantee behavior");
  });

  it("continues without injection when no skills are active", async () => {
    const decisions: MiddlewareDecision[] = [];
    const engine = MiddlewareEngine.create({
      audit: false,
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });
    engine.register(createSkillActivationMiddleware([]));

    const result = await engine.dispatchSystemPrompt(baseCtx());

    expect(result).toEqual({});
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      name: "skill:activation",
      policyId: "skill.activation",
      verdict: "continue",
      reason: "no active skills",
    });
  });

  it("makes same-layer execution conflicts observable while composing deterministically", async () => {
    const decisions: MiddlewareDecision[] = [];
    const engine = MiddlewareEngine.create({
      audit: false,
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });
    engine.register(
      createSkillActivationMiddleware([
        skill("exec-b", "execution", "Execution B"),
        skill("exec-a", "execution", "Execution A"),
        skill("guard", "guarantee", "Guard behavior"),
      ]),
    );

    const result = await engine.dispatchSystemPrompt(baseCtx());
    const context = result.appendContext ?? "";

    expect(context.indexOf("[execution:exec-a]")).toBeLessThan(
      context.indexOf("[execution:exec-b]"),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.policyId).toBe("skill.activation.conflict");
    expect(decisions[0]?.reason).toContain("conflict");
    expect(decisions[0]?.reason).toContain("multiple execution skills (exec-a, exec-b)");
  });
});

function skill(id: string, layer: Skill.Layer, promptFragment: string): Skill.Definition {
  return {
    id,
    name: id,
    description: `${id} description`,
    scope: "local",
    layer,
    path: `.openomni/skills/${id}/SKILL.md`,
    promptFragment,
  };
}

function baseCtx() {
  return {
    steps: [],
    usage: emptyUsage,
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}
