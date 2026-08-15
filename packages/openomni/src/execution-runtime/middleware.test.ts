import { describe, expect, it, spyOn } from "bun:test";
import { PolicyEngine } from "@openomni/agent";
import { Session } from "@openomni/session";
import { InjectionQueue } from "./injection-queue";
import { buildWorkerMiddleware } from "./middleware";
import { findRegistration, invokeTool } from "./middleware-test-fixture";

describe("buildWorkerMiddleware backward compatibility", () => {
  it("returns worker-owned registrations", () => {
    const registrations = buildWorkerMiddleware({});
    expect(registrations.map((r) => r.name)).toEqual([
      "builtin:budget-reassurance",
      "builtin:budget-warning",
      "builtin:compaction",
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
    await expect(invokeTool(toolPermission, "tool:read")).resolves.toMatchObject({
      verdict: "allow",
    });
    await expect(invokeTool(toolPermission, "tool:write")).resolves.toMatchObject({
      verdict: "deny",
    });
  });
});

describe("buildWorkerMiddleware injection queue persistence", () => {
  it("emits a queued response when history persistence throws a non-Error value", async () => {
    const queue = InjectionQueue.create();
    queue.enqueue("run-storage-failure", {
      messageId: "message-storage-failure",
      output: "deliver despite non-Error storage failure",
      injectToHistory: true,
      timestamp: 1,
    });
    const registration = findRegistration(
      buildWorkerMiddleware({ injectionQueue: queue }),
      "builtin:injection-queue-drain",
    );
    if (registration === undefined) throw new Error("expected injection queue registration");
    const addMessageSpy = spyOn(Session, "addMessage").mockImplementation(() => {
      // biome-ignore lint/style/useThrowOnlyError: exercises the defensive catch for hostile non-Error throws.
      throw "storage unavailable";
    });
    const engine = PolicyEngine.create({ audit: false });
    engine.register(registration);

    try {
      const decision = await engine.dispatchPoint("run.turn.post", {
        sessionId: "session-storage-failure",
        runId: "run-storage-failure",
        turnIndex: 0,
        turnResult: { type: "stop" },
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 0,
        isCompletion: true,
        continuationCount: 0,
        elapsedMs: 0,
      });

      expect(decision.effects).toEqual([
        {
          type: "prompt.inject_message",
          message: "deliver despite non-Error storage failure",
          role: "assistant",
        },
      ]);
      expect(queue.hasPending("run-storage-failure")).toBe(false);
    } finally {
      addMessageSpy.mockRestore();
    }
  });
});
