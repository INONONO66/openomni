import { describe, expect, test } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { PolicyEngine } from "../src/index";

const POINT = "run.turn.pre" as const;
const context = { sessionId: "session-invariant", runId: "run-invariant", turnIndex: 0, traceContext: { traceId: "trace-invariant" } };

type Verdict = "allow" | "deny" | "pending";
function registration(name: string, priority: number, calls: string[], verdict: Verdict = "allow") {
  return {
    kind: "point" as const,
    name,
    pointIds: [POINT],
    effectCapabilities: { [POINT]: [] },
    priority,
    fn: () => {
      calls.push(name);
      return PolicyDecision[verdict]({ policyId: name });
    },
  };
}

describe("engine invariants hold under the package's own suite", () => {
  for (const { name, entries, verdict, calls: expectedCalls } of [
    {
      name: "a deny short-circuits: later registrations never execute",
      entries: [["denier", 0, "deny"], ["after-deny", 10, "allow"]],
      verdict: "deny",
      calls: ["denier"],
    },
    {
      name: "pending outranks allow in composition",
      entries: [["allower", 0, "allow"], ["pender", 10, "pending"]],
      verdict: "pending",
      calls: ["allower", "pender"],
    },
    {
      name: "priority orders evaluation — ascending, registration order breaks ties",
      entries: [["last", 100, "allow"], ["first", 1, "allow"], ["tie-a", 50, "allow"], ["tie-b", 50, "allow"]],
      verdict: "allow",
      calls: ["first", "tie-a", "tie-b", "last"],
    },
  ] as const) {
    test(name, async () => {
      const calls: string[] = [];
      const engine = PolicyEngine.create({ clock: Date.now, audit: false });
      for (const [id, priority, result] of entries) engine.register(registration(id, priority, calls, result));
      const decision = await engine.dispatchPoint(POINT, context);
      expect(decision.verdict).toBe(verdict);
      expect(calls).toEqual([...expectedCalls]);
    });
  }

  test("a deny at a side-effect boundary escalates to run.abort", async () => {
    const engine = PolicyEngine.create({ clock: Date.now, audit: false });
    engine.register({
      kind: "point", name: "denier-without-abort", pointIds: [POINT], effectCapabilities: { [POINT]: [] }, priority: 0,
      fn: () => PolicyDecision.deny({ policyId: "denier-without-abort", reasonCodes: ["invariant.deny_reason"] }),
    });
    const decision = await engine.dispatchPoint(POINT, context);
    expect(decision.verdict).toBe("deny");
    expect(decision.effects[0]).toEqual({ type: "run.abort", reason: "invariant.deny_reason" });
  });
});
