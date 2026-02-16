import { describe, it, expect } from "bun:test";
import { PermissionGate, PermissionContext } from "../../src/worker/permission";

describe("PermissionGate", () => {
  describe("evaluate", () => {
    it("returns 'ask' when taskPolicy is 'ask'", () => {
      const context: PermissionContext = {
        taskPolicy: "ask",
        agentPolicy: "notify",
        systemDefault: "notify",
      };

      const result = PermissionGate.evaluate(context);

      expect(result.level).toBe("ask");
      expect(result.reason).toBe("Selected from task policy");
    });

    it("returns 'notify' when taskPolicy is 'notify'", () => {
      const context: PermissionContext = {
        taskPolicy: "notify",
        agentPolicy: "notify",
        systemDefault: "notify",
      };

      const result = PermissionGate.evaluate(context);

      expect(result.level).toBe("notify");
    });

    it("returns 'deny' when taskPolicy is 'deny'", () => {
      const context: PermissionContext = {
        taskPolicy: "deny",
        agentPolicy: "notify",
        systemDefault: "notify",
      };

      const result = PermissionGate.evaluate(context);

      expect(result.level).toBe("deny");
      expect(result.reason).toBe("Selected from task policy");
    });

    it("uses taskPolicy first even when agentPolicy is more restrictive", () => {
      const context: PermissionContext = {
        taskPolicy: "notify",
        agentPolicy: "deny",
        systemDefault: "notify",
      };

      const result = PermissionGate.evaluate(context);

      expect(result.level).toBe("notify");
      expect(result.reason).toBe("Selected from task policy");
    });

    it("uses agentPolicy when taskPolicy is undefined", () => {
      const context: PermissionContext = {
        taskPolicy: undefined,
        agentPolicy: "ask",
        systemDefault: "deny",
      };

      const result = PermissionGate.evaluate(context);

      expect(result.level).toBe("ask");
      expect(result.reason).toBe("Selected from agent policy");
    });

    it("uses system default when task and agent policies are undefined", () => {
      const context: PermissionContext = {
        taskPolicy: undefined,
        agentPolicy: undefined,
        systemDefault: "deny",
      };

      const result = PermissionGate.evaluate(context);

      expect(result.level).toBe("deny");
      expect(result.reason).toBe("Selected from system default");
    });
  });
});
