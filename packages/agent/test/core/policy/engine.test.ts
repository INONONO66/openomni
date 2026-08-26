import { describe, expect, it } from "bun:test";
import { Operational, Policy, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import { atPoint, toolPreContext, turnPostContext } from "../../helpers/policy-decision";

async function withinTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("expected Bus event")), 1_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function nextWarning(): Promise<unknown> {
  return new Promise((resolve) => {
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (event) => {
      unsubscribe();
      resolve(event);
    });
  });
}

describe("agent policy Bus integration", () => {
  it("publishes synchronous onDecision observer errors as agent.policy warnings", async () => {
    Bus.reset();
    const warning = nextWarning();
    try {
      const engine = PolicyEngine.create({
        onDecision: () => {
          throw new Error("observer failed");
        },
        auditEmit: Bus.publish,
      });
      engine.register(
        atPoint("run.turn.post", {
          name: "observer-isolation",
          priority: 100,
          fn: () => PolicyDecision.allow({ policyId: "observer-isolation" }),
        }),
      );

      const decision = await engine.dispatchPoint("run.turn.post", {
        ...turnPostContext(),
        traceContext: {
          traceId: "trace-observer",
          sessionId: "session-observer",
          runId: "run-1",
        },
      });

      expect(decision.verdict).toBe("allow");
      expect(await withinTimeout(warning)).toMatchObject({
        traceId: "trace-observer",
        sessionId: "session-observer",
        component: "agent.policy",
        msg: "onDecision observer error",
        context: {
          timing: "turn.finish",
          policyId: "observer-isolation",
          error: "Error: observer failed",
        },
      });
    } finally {
      Bus.reset();
    }
  });

  it("publishes asynchronous onDecision rejections as agent.policy warnings", async () => {
    Bus.reset();
    const warning = nextWarning();
    try {
      const engine = PolicyEngine.create({
        traceContext: { traceId: "trace-async", sessionId: "session-async" },
        onDecision: async () => {
          throw new Error("async observer failed");
        },
        auditEmit: Bus.publish,
      });
      engine.register(
        atPoint("run.turn.post", {
          name: "async-observer-isolation",
          priority: 100,
          fn: () => PolicyDecision.allow({ policyId: "async-observer-isolation" }),
        }),
      );

      const decision = await engine.dispatchPoint("run.turn.post", turnPostContext());

      expect(decision.verdict).toBe("allow");
      expect(await withinTimeout(warning)).toMatchObject({
        component: "agent.policy",
        msg: "onDecision observer error",
        context: {
          timing: "turn.finish",
          policyId: "async-observer-isolation",
          error: "Error: async observer failed",
        },
      });
    } finally {
      Bus.reset();
    }
  });

  it("publishes Policy.Events.Evaluated through Bus with agent attribution", async () => {
    Bus.reset();
    const evaluated = new Promise<unknown>((resolve) => {
      const unsubscribe = Bus.subscribe(Policy.Events.Evaluated, (event) => {
        unsubscribe();
        resolve(event);
      });
    });
    try {
      const engine = PolicyEngine.create({
        traceContext: {
          traceId: "trace-policy",
          sessionId: "sess-policy",
          runId: "run-policy",
          agentName: "policy-agent",
        },
        auditEmit: Bus.publish,
      });
      engine.register(
        atPoint("tool.native.pre", {
          name: "policy-check",
          effects: ["run.abort"],
          priority: 100,
          fn: () =>
            PolicyDecision.deny({
              policyId: "test.policy",
              reasonCodes: ["blocked_by_test_policy"],
              effects: [{ type: "run.abort", reason: "blocked_by_test_policy" }],
            }),
        }),
      );

      await engine.dispatchPoint("tool.native.pre", { ...toolPreContext(), toolName: "shell" });

      expect(await withinTimeout(evaluated)).toMatchObject({
        traceId: "trace-policy",
        sessionId: "sess-policy",
        runId: "run-policy",
        policyId: "policy-check",
        actor: { kind: "agent", name: "policy-agent", runId: "run-policy" },
        action: "tool.call",
        resource: "shell",
        verdict: "deny",
        reason: "blocked_by_test_policy",
      });
    } finally {
      Bus.reset();
    }
  });
});
