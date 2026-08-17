import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { buildWorkerMiddleware } from "./middleware";
import { findRegistration, invokeTool } from "./middleware-test-fixture";

describe("buildWorkerMiddleware policy plan path", () => {
  it("accepts policyPlan in config", () => {
    const policyPlan: Policy.PolicyPlan = {
      policies: [
        {
          id: "builtin:tool-permission",
          required: true,
          config: { permission: { action: "tool.call" } },
        },
      ],
      labels: ["security", "audit"],
      registryVersion: "1.0.0",
    };

    const registrations = buildWorkerMiddleware({ policyPlan });
    expect(registrations.map((registration) => registration.name)).toEqual([
      "builtin:budget-reassurance",
      "builtin:budget-warning",
      "builtin:compaction",
      "builtin:tool-permission",
      "builtin:idle-nudge",
    ]);
    // Stateless registrations stay canonical points; the stateful builtins
    // (budget nudges, idle-nudge) are per-run factories since the audit-H1
    // fix, so their closure state is minted per policy engine (= per run).
    expect(
      registrations.every(
        (registration) => registration.kind === "point" || registration.kind === "factory",
      ),
    ).toBe(true);
    expect(
      registrations
        .filter((registration) => registration.kind === "factory")
        .map((registration) => registration.name)
        .sort(),
    ).toEqual(["builtin:budget-reassurance", "builtin:budget-warning", "builtin:idle-nudge"]);
  });

  it("resolves builtin policies from policyPlan via registry", () => {
    const policyPlan: Policy.PolicyPlan = {
      policies: [
        {
          id: "builtin:tool-permission",
          required: true,
          config: { permission: { action: "tool.call" } },
        },
        { id: "builtin:idle-nudge", required: true, config: {} },
      ],
      labels: ["security"],
    };

    const registrations = buildWorkerMiddleware({ policyPlan });
    expect(registrations.map((r) => r.name)).toEqual([
      "builtin:budget-reassurance",
      "builtin:budget-warning",
      "builtin:compaction",
      "builtin:tool-permission",
      "builtin:idle-nudge",
    ]);
  });

  it("does not duplicate lifecycle defaults that a policyPlan already owns", () => {
    const policyPlan: Policy.PolicyPlan = {
      policies: [
        { id: "builtin:budget-reassurance", required: true, config: {} },
        { id: "builtin:budget-warning", required: true, config: {} },
        {
          id: "builtin:compaction",
          required: true,
          config: { contextWindowTokens: 1000 },
        },
        {
          id: "builtin:tool-permission",
          required: true,
          config: { permission: { action: "tool.call" } },
        },
      ],
      labels: ["security"],
    };

    const registrations = buildWorkerMiddleware({
      policyPlan,
      compaction: { contextWindowTokens: 2000 },
    });
    expect(registrations.map((registration) => registration.name)).toEqual([
      "builtin:budget-reassurance",
      "builtin:budget-warning",
      "builtin:compaction",
      "builtin:tool-permission",
      "builtin:idle-nudge",
    ]);
  });

  it("can resolve only policy-owned middleware for nested child policy plans", () => {
    const policyPlan: Policy.PolicyPlan = {
      policies: [
        {
          id: "builtin:tool-permission",
          required: true,
          config: { permission: { action: "tool.call" } },
        },
      ],
      labels: ["security"],
    };

    const registrations = buildWorkerMiddleware({
      policyPlan,
      includeLifecycle: false,
      includeIdle: false,
    });
    expect(registrations.map((registration) => registration.name)).toEqual([
      "builtin:tool-permission",
    ]);
  });

  it("preserves legacy permissions when policyPlan omits tool permission config", async () => {
    const policyPlan: Policy.PolicyPlan = {
      policies: [
        {
          id: "builtin:tool-permission",
          required: true,
        },
      ],
      labels: ["security"],
    };
    const permissions = { action: "tool.call", allowlist: ["tool:read"] };

    const registrations = buildWorkerMiddleware({ policyPlan, permissions });
    expect(registrations.map((r) => r.name)).toEqual([
      "builtin:budget-reassurance",
      "builtin:budget-warning",
      "builtin:compaction",
      "builtin:tool-permission",
      "builtin:idle-nudge",
    ]);
    const toolPermission = findRegistration(registrations, "builtin:tool-permission");
    await expect(invokeTool(toolPermission, "tool:read")).resolves.toMatchObject({
      verdict: "allow",
    });
    await expect(invokeTool(toolPermission, "tool:write")).resolves.toMatchObject({
      verdict: "deny",
    });
  });

  it("keeps explicit policyPlan permission config ahead of legacy permissions", async () => {
    const policyPlan: Policy.PolicyPlan = {
      policies: [
        {
          id: "builtin:tool-permission",
          required: true,
          config: { permission: { action: "tool.call", allowlist: ["tool:plan"] } },
        },
      ],
      labels: ["security"],
    };
    const permissions = { action: "tool.call", allowlist: ["tool:legacy"] };

    const registrations = buildWorkerMiddleware({ policyPlan, permissions });
    const toolPermission = findRegistration(registrations, "builtin:tool-permission");
    await expect(invokeTool(toolPermission, "tool:plan")).resolves.toMatchObject({
      verdict: "allow",
    });
    await expect(invokeTool(toolPermission, "tool:legacy")).resolves.toMatchObject({
      verdict: "deny",
    });
  });

  it("fails closed for malformed explicit policyPlan permission config", async () => {
    const permissions = { action: "tool.call", allowlist: ["tool:legacy"] };

    for (const permission of [
      { action: "tool.call", allowlist: "tool:plan" },
      undefined,
      null,
    ] as const) {
      const policyPlan: Policy.PolicyPlan = {
        policies: [
          {
            id: "builtin:tool-permission",
            required: true,
            config: { permission },
          },
        ],
        labels: ["security"],
      };

      const registrations = buildWorkerMiddleware({ policyPlan, permissions });
      const toolPermission = findRegistration(registrations, "builtin:tool-permission");
      await expect(invokeTool(toolPermission, "tool:legacy")).resolves.toMatchObject({
        verdict: "deny",
      });
    }
  });
});
