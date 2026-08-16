import { describe, expect, test } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyEngine } from "../src/index";

/**
 * In-package smoke pins for the engine's three headline invariants (#606
 * audit): each previously survived mutation under this package's own suite —
 * the only defense was packages/agent's conformance tests, so a policy-local
 * refactor loop ran unprotected.
 */
const POINT = "run.turn.pre" as const;

function turnContext() {
  return {
    sessionId: "session-invariant",
    runId: "run-invariant",
    turnIndex: 0,
    traceContext: { traceId: "trace-invariant" },
  };
}

function recorder(
  name: string,
  priority: number,
  calls: string[],
  verdict: "allow" | "deny" | "pending" = "allow",
) {
  return {
    kind: "point" as const,
    name,
    pointIds: [POINT],
    effectCapabilities: { [POINT]: [] },
    priority,
    fn: () => {
      calls.push(name);
      if (verdict === "deny") {
        return PolicyDecision.deny({ policyId: name });
      }
      if (verdict === "pending") {
        return PolicyDecision.pending({ policyId: name });
      }
      return PolicyDecision.allow({ policyId: name });
    },
  };
}

describe("engine invariants hold under the package's own suite", () => {
  test("a deny short-circuits: later registrations never execute", async () => {
    const calls: string[] = [];
    const engine = PolicyEngine.create({ audit: false });
    // Selection is ASCENDING priority: the priority-0 denier runs first and
    // the priority-10 registration must never execute.
    engine.register(recorder("denier", 0, calls, "deny"));
    engine.register(recorder("after-deny", 10, calls));

    const decision = await engine.dispatchPoint(POINT, turnContext());

    expect(decision.verdict).toBe("deny");
    expect(calls).toEqual(["denier"]);
  });

  test("pending outranks allow in composition", async () => {
    const calls: string[] = [];
    const engine = PolicyEngine.create({ audit: false });
    engine.register(recorder("allower", 0, calls));
    engine.register(recorder("pender", 10, calls, "pending"));

    const decision = await engine.dispatchPoint(POINT, turnContext());

    expect(decision.verdict).toBe("pending");
    expect(calls).toEqual(["allower", "pender"]);
  });

  test("priority orders evaluation — ascending, registration order breaks ties", async () => {
    const calls: string[] = [];
    const engine = PolicyEngine.create({ audit: false });
    engine.register(recorder("last", 100, calls));
    engine.register(recorder("first", 1, calls));
    engine.register(recorder("tie-a", 50, calls));
    engine.register(recorder("tie-b", 50, calls));

    await engine.dispatchPoint(POINT, turnContext());

    // Equal priority resolves by registration order (tie-a before tie-b).
    expect(calls).toEqual(["first", "tie-a", "tie-b", "last"]);
  });
});
