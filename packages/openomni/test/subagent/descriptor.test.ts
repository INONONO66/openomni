import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PolicyContext, PolicyRegistration } from "@openomni/agent";
import { PolicyDecision, type RuntimeResource } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";
import { BackgroundManager } from "../../src/subagent/background-manager";
import { BackgroundLimitsMiddleware } from "../../src/subagent/middleware/background-limits";
import { SubagentRuntime } from "../../src/subagent/runtime";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

type DescriptorPolicyContext = PolicyContext & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

type PreLaunchContextWithDescriptor = Parameters<
  typeof BackgroundLimitsMiddleware.evaluatePreLaunch
>[0] & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

function captureDescriptorPolicy(
  onCapture: (ctx: DescriptorPolicyContext) => void,
): PolicyRegistration {
  return {
    name: "test:capture-descriptor",
    timing: "invoke.prepare",
    priority: 0,
    fn: (ctx) => {
      onCapture(ctx);
      return PolicyDecision.deny({
        policyId: "test",
        reasonCodes: ["descriptor captured"],
        effects: [{ type: "run.abort", reason: "descriptor captured" }],
      });
    },
  };
}

describe("subagent resource descriptors", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
    Storage.reset();
  });

  test("SubagentRuntime.spawn attaches a resource descriptor to invoke.prepare", async () => {
    let captured: DescriptorPolicyContext | undefined;

    try {
      await SubagentRuntime.spawn({
        agentName: "worker",
        title: "delegate work",
        prompt: "do work",
        model,
        middleware: [captureDescriptorPolicy((ctx) => (captured = ctx))],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("descriptor captured");
    }

    expect(captured?.resourceDescriptor).toEqual({
      id: "worker:agent:subagent_spawn",
      kind: "worker",
      source: { type: "agent", agentId: "worker" },
      labels: ["source.agent", "delegation.subagent"],
      capabilities: ["delegation.spawn"],
      effects: ["session.create"],
    });
    expect(captured?.toolLabels).toEqual(["source.agent", "delegation.subagent"]);
  });

  test("SubagentRuntime.spawnBackground attaches a background worker descriptor", async () => {
    let captured: DescriptorPolicyContext | undefined;

    try {
      await SubagentRuntime.spawnBackground({
        agentName: "worker",
        title: "background work",
        prompt: "do background work",
        model,
        middleware: [captureDescriptorPolicy((ctx) => (captured = ctx))],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("descriptor captured");
    }

    expect(captured?.resourceDescriptor).toEqual({
      id: "worker:agent:background_launch",
      kind: "worker",
      source: { type: "agent", agentId: "worker" },
      labels: ["source.agent", "delegation.background"],
      capabilities: ["delegation.background"],
      effects: ["session.create"],
    });
  });

  test("BackgroundManager.launch passes a background descriptor into the launch policy gate", async () => {
    let captured: PreLaunchContextWithDescriptor | undefined;
    const policySpy = spyOn(BackgroundLimitsMiddleware, "evaluatePreLaunch").mockImplementation(
      async (ctx) => {
        captured = ctx;
        return { verdict: PolicyDecision.allow({ policyId: "test" }), shouldQueue: false };
      },
    );
    const spawnSpy = spyOn(SubagentRuntime, "spawnBackground").mockResolvedValue({
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });
    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();

    await manager.launch({
      agentName: "worker",
      prompt: "do background work",
      model,
      parentSessionId,
    });

    expect(captured?.resourceDescriptor).toEqual({
      id: "worker:agent:background_launch",
      kind: "worker",
      source: { type: "agent", agentId: "worker" },
      labels: ["source.agent", "delegation.background"],
      capabilities: ["delegation.background"],
      effects: ["session.create"],
    });

    manager.dispose();
    policySpy.mockRestore();
    spawnSpy.mockRestore();
  });
});
