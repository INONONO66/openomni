import { describe, it, expect } from "bun:test";
import { PermissionGate, PermissionContext } from "../../src/loop/permission";

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
      expect(result.reason).toBe("Restricted by task policy");
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
      expect(result.reason).toBe("Restricted by task policy");
    });

    it("checks taskPolicy before agentPolicy", () => {
      const context: PermissionContext = {
        taskPolicy: "ask",
        agentPolicy: "notify",
        systemDefault: "notify",
      };

      const result = PermissionGate.evaluate(context);

      // taskPolicy 'ask' is more restrictive than agentPolicy 'notify'
      // so taskPolicy should be selected
      expect(result.level).toBe("ask");
      expect(result.reason).toBe("Restricted by task policy");
    });

    it("checks agentPolicy before systemDefault", () => {
      const context: PermissionContext = {
        taskPolicy: "notify",
        agentPolicy: "ask",
        systemDefault: "notify",
      };

      const result = PermissionGate.evaluate(context);

      // agentPolicy 'ask' is more restrictive than systemDefault 'notify'
      // so agentPolicy should be selected
      expect(result.level).toBe("ask");
      expect(result.reason).toBe("Restricted by agent policy");
    });

    it("returns most restrictive permission when all specified", () => {
      const context: PermissionContext = {
        taskPolicy: "notify",
        agentPolicy: "ask",
        systemDefault: "deny",
      };

      const result = PermissionGate.evaluate(context);

      // 'deny' is most restrictive (3), then 'ask' (2), then 'notify' (1)
      expect(result.level).toBe("deny");
    });
  });
});
