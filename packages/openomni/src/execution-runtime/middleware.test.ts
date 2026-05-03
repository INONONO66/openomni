import { describe, expect, it } from "bun:test";
import { buildWorkerMiddleware } from "./middleware";

describe("buildWorkerMiddleware", () => {
  it("returns array of 4 registrations", () => {
    const registrations = buildWorkerMiddleware({});
    expect(registrations).toHaveLength(4);
  });

  it("first registration is tool-guard with fail-closed policy", () => {
    const registrations = buildWorkerMiddleware({});
    const toolGuard = registrations[0];
    if (toolGuard == null) {
      throw new Error("expected tool-guard registration");
    }
    expect(toolGuard.name).toBe("builtin:tool-guard");
    expect(toolGuard.failPolicy).toBe("fail-closed");
  });

  it("includes budget-reassurance middleware", () => {
    const registrations = buildWorkerMiddleware({});
    const budgetReassurance = registrations.find((r) => r.name === "builtin:budget-reassurance");
    expect(budgetReassurance).toBeDefined();
  });

  it("includes budget-warning middleware", () => {
    const registrations = buildWorkerMiddleware({});
    const budgetWarning = registrations.find((r) => r.name === "builtin:budget-warning");
    expect(budgetWarning).toBeDefined();
  });

  it("includes idle-nudge middleware", () => {
    const registrations = buildWorkerMiddleware({});
    const idleNudge = registrations.find((r) => r.name === "builtin:idle-nudge");
    expect(idleNudge).toBeDefined();
  });

  it("passes permissions to tool-guard", () => {
    const permissions = { action: "tool.call", allowlist: ["tool:read"] };
    const registrations = buildWorkerMiddleware({ permissions });
    expect(registrations[0]?.name).toBe("builtin:tool-guard");
  });
});
