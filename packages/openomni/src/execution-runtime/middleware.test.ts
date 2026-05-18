import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { buildWorkerMiddleware } from "./middleware";

function findRegistration(registrations: ReturnType<typeof buildWorkerMiddleware>, name: string) {
  return registrations.find((registration) => registration.name === name);
}

function invokeTool(
  registration: ReturnType<typeof buildWorkerMiddleware>[number] | undefined,
  toolName: string,
) {
  return registration?.fn({
    timing: "invoke.prepare",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    toolName,
  });
}

describe("buildWorkerMiddleware", () => {
  describe("backward compatibility (no policyPlan)", () => {
    it("returns worker-owned registrations", () => {
      const registrations = buildWorkerMiddleware({});
      expect(registrations.map((r) => r.name)).toEqual([
        "builtin:budget-reassurance",
        "builtin:budget-warning",
        "builtin:tool-permission",
        "builtin:idle-nudge",
      ]);
    });

    it("tool permission registration is fail-closed", () => {
      const registrations = buildWorkerMiddleware({});
      const toolPermission = findRegistration(registrations, "builtin:tool-permission");
      if (toolPermission == null) {
        throw new Error("expected tool permission registration");
      }
      expect(toolPermission.name).toBe("builtin:tool-permission");
      expect(toolPermission.failPolicy).toBe("fail-closed");
    });

    it("includes idle-nudge middleware", () => {
      const registrations = buildWorkerMiddleware({});
      const idleNudge = registrations.find((r) => r.name === "builtin:idle-nudge");
      expect(idleNudge).toBeDefined();
    });

    it("passes permissions to tool permission middleware", () => {
      const permissions = { action: "tool.call", allowlist: ["tool:read"] };
      const registrations = buildWorkerMiddleware({ permissions });
      expect(findRegistration(registrations, "builtin:tool-permission")?.name).toBe(
        "builtin:tool-permission",
      );
    });

    it("forwards event emitter metadata to legacy tool permission middleware", async () => {
      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      const registrations = buildWorkerMiddleware({
        permissions: { action: "tool.call", allowlist: ["tool:read"] },
        eventEmitter: {
          emit: (name, data) => events.push({ name, data }),
        },
        source: "worker-runtime",
      });
      const toolPermission = findRegistration(registrations, "builtin:tool-permission");

      await expect(invokeTool(toolPermission, "tool:read")).resolves.toMatchObject({
        verdict: "allow",
      });

      expect(events).toEqual([
        {
          name: "tool.execution.started",
          data: expect.objectContaining({
            sessionId: "worker-runtime",
            toolName: "tool:read",
          }),
        },
      ]);
    });
  });

  describe("policy plan path (with policyPlan)", () => {
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
      expect(registrations).toBeDefined();
      expect(Array.isArray(registrations)).toBe(true);
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

    it("hydrates event emitter metadata into policyPlan tool permission middleware", async () => {
      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      const policyPlan: Policy.PolicyPlan = {
        policies: [
          {
            id: "builtin:tool-permission",
            required: true,
            config: { permission: { action: "tool.call", allowlist: ["tool:read"] } },
          },
        ],
        labels: ["security"],
      };

      const registrations = buildWorkerMiddleware({
        policyPlan,
        eventEmitter: {
          emit: (name, data) => events.push({ name, data }),
        },
        source: "policy-plan-runtime",
      });
      const toolPermission = findRegistration(registrations, "builtin:tool-permission");

      await expect(invokeTool(toolPermission, "tool:read")).resolves.toMatchObject({
        verdict: "allow",
      });

      expect(events).toEqual([
        {
          name: "tool.execution.started",
          data: expect.objectContaining({
            sessionId: "policy-plan-runtime",
            toolName: "tool:read",
          }),
        },
      ]);
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
});
