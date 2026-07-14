import { describe, expect, it } from "bun:test";
import { buildWorkerMiddleware } from "./middleware";
import { findRegistration, invokeTool } from "./middleware-test-fixture";

describe("buildWorkerMiddleware backward compatibility", () => {
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
    if (toolPermission == null) throw new Error("expected tool permission registration");
    expect(toolPermission.name).toBe("builtin:tool-permission");
    expect(toolPermission.failPolicy).toBe("fail-closed");
  });

  it("can omit idle-nudge middleware", () => {
    const registrations = buildWorkerMiddleware({ includeIdle: false });
    const idleNudge = registrations.find((r) => r.name === "builtin:idle-nudge");
    expect(idleNudge).toBeUndefined();
  });

  it("passes permissions to tool permission middleware", async () => {
    const permissions = { action: "tool.call", allowlist: ["tool:read"] };
    const registrations = buildWorkerMiddleware({ permissions });
    const toolPermission = findRegistration(registrations, "builtin:tool-permission");
    await expect(invokeTool(toolPermission, "tool:write")).resolves.toMatchObject({
      verdict: "deny",
    });
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
