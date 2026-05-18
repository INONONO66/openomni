import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { buildWorkerMiddleware } from "./middleware";

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
        "builtin:tool-permission",
        "builtin:idle-nudge",
      ]);
    });

    it("first registration is tool permission with fail-closed policy", () => {
      const registrations = buildWorkerMiddleware({});
      const toolPermission = registrations[0];
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
      expect(registrations[0]?.name).toBe("builtin:tool-permission");
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
        "builtin:tool-permission",
        "builtin:idle-nudge",
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
      expect(registrations.map((r) => r.name)).toEqual(["builtin:tool-permission"]);
      await expect(invokeTool(registrations[0], "tool:read")).resolves.toMatchObject({
        verdict: "allow",
      });
      await expect(invokeTool(registrations[0], "tool:write")).resolves.toMatchObject({
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
      await expect(invokeTool(registrations[0], "tool:plan")).resolves.toMatchObject({
        verdict: "allow",
      });
      await expect(invokeTool(registrations[0], "tool:legacy")).resolves.toMatchObject({
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
        await expect(invokeTool(registrations[0], "tool:legacy")).resolves.toMatchObject({
          verdict: "deny",
        });
      }
    });
  });
});
