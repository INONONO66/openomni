import { describe, expect, it } from "bun:test";
import { buildWorkerMiddleware } from "./middleware";

describe("buildWorkerMiddleware", () => {
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
