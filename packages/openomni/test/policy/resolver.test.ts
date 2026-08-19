import { describe, expect, it } from "bun:test";
import { PolicyResolver } from "../../src/policy";

describe("PolicyResolver", () => {
  it("returns matching policies in a PolicyPlan", () => {
    const resolver = PolicyResolver.create([
      {
        match: { all: ["actor.owner"], any: ["surface.discord", "surface.github"] },
        policies: ["policy:trusted-surface"],
        required: true,
      },
      {
        match: { all: ["actor.guest"] },
        policies: ["policy:guest"],
      },
    ]);

    const plan = resolver.resolve({
      actorLabels: ["actor.owner"],
      agentLabels: ["agent.researcher"],
      runLabels: ["run.direct"],
      surfaceLabels: ["surface.github"],
    });

    expect(plan).toEqual({
      policies: [
        {
          id: "builtin:tool-permission",
          required: true,
          config: { permission: { action: "tool.call" } },
        },
        { id: "builtin:idle-nudge", required: true },
        { id: "policy:trusted-surface", required: true },
      ],
      labels: ["actor.owner", "agent.researcher", "run.direct", "surface.github"],
    });
  });

  it("always includes default policies WITH the gate's explicit tool permission", () => {
    const resolver = PolicyResolver.create([]);

    const plan = resolver.resolve({
      actorLabels: [],
      agentLabels: [],
      runLabels: [],
      surfaceLabels: [],
    });

    // Audit batch A: the plan CARRIES the gate's ruleset — downstream
    // hydration fails closed on an absent permission, so an id-only entry
    // would deny every tool.
    expect(plan.policies).toEqual([
      {
        id: "builtin:tool-permission",
        required: true,
        config: { permission: { action: "tool.call" } },
      },
      { id: "builtin:idle-nudge", required: true },
    ]);
  });

  it("stamps an injected tool permission and keeps it when a rule re-selects the guard", () => {
    const resolver = PolicyResolver.create(
      [{ match: { any: ["risk.high"] }, policies: ["builtin:tool-permission"], required: true }],
      { toolPermission: { action: "tool.call", allowlist: ["tool:read"] } },
    );

    const plan = resolver.resolve({
      actorLabels: [],
      agentLabels: [],
      runLabels: ["risk.high"],
      surfaceLabels: [],
    });

    expect(plan.policies).toContainEqual({
      id: "builtin:tool-permission",
      required: true,
      config: { permission: { action: "tool.call", allowlist: ["tool:read"] } },
    });
  });

  it("matches all, any, and none label clauses", () => {
    const resolver = PolicyResolver.create([
      {
        match: { all: ["actor.owner", "agent.coder"] },
        policies: ["policy:all"],
      },
      {
        match: { any: ["surface.telegram", "surface.github"] },
        policies: ["policy:any"],
      },
      {
        match: { none: ["risk.high"] },
        policies: ["policy:none"],
      },
      {
        match: { all: ["actor.owner"], none: ["risk.high"] },
        policies: ["policy:blocked-by-none"],
      },
    ]);

    const plan = resolver.resolve({
      actorLabels: ["actor.owner"],
      agentLabels: [{ value: "agent.coder", source: "agent_profile" }],
      runLabels: ["risk.high"],
      surfaceLabels: ["surface.github"],
    });

    expect(plan.policies.map((policy) => policy.id)).toEqual([
      "builtin:tool-permission",
      "builtin:idle-nudge",
      "policy:all",
      "policy:any",
    ]);
    expect(plan.labels).toEqual(["actor.owner", "agent.coder", "risk.high", "surface.github"]);
  });
});
