import { describe, expect, it, mock } from "bun:test";
import { PolicyEngine } from "../../../src/core/policy";
import {
  abortRun,
  allow,
  atPoint,
  deny,
  registerAt,
  toolPreContext,
} from "../../helpers/policy-decision";

function env(): Record<string, string | undefined> {
  return (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process
    .env;
}

describe("PolicyEngine deny terminal dispatch", () => {
  it("stops dispatch on deny and preserves reason and policyId", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => abortRun("test.late", "late"));

    registerAt(
      engine,
      "tool.native.pre",
      "deny-first",
      0,
      () => deny("test.deny-first", "blocked"),
      ["audit.annotate"],
    );
    registerAt(engine, "tool.native.pre", "after", 10, after, ["run.abort"]);

    const verdict = await engine.dispatchPoint("tool.native.pre", toolPreContext());

    expect(verdict.verdict).toBe("deny");
    expect(verdict.policyId).toBe("agent.policy.composed");
    expect(verdict.reasonCodes).toContain("blocked");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("allows continue verdicts without policy metadata at pre-boundary points", async () => {
    const previousNodeEnv = env().NODE_ENV;
    env().NODE_ENV = "production";
    try {
      const engine = PolicyEngine.create();
      const after = mock(() => allow());

      engine.register(
        atPoint("tool.native.pre", {
          name: "missing-policy-id",
          priority: 0,
          fn: () => allow(),
        }),
      );
      engine.register(
        atPoint("tool.native.pre", {
          name: "after",
          priority: 10,
          fn: after,
        }),
      );

      const verdict = await engine.dispatchPoint("tool.native.pre", toolPreContext());

      expect(verdict.verdict).toBe("allow");
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      if (previousNodeEnv === undefined) {
        delete env().NODE_ENV;
      } else {
        env().NODE_ENV = previousNodeEnv;
      }
    }
  });
});
