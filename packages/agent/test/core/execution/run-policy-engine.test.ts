import { describe, expect, it, mock } from "bun:test";
import { Bus } from "../../../src/index";
import { abortRun, allow } from "../../helpers/policy-decision";
import { buildPolicyEngine } from "../../../src/core/execution/run";
import { makeAgentBase, makeConfig } from "./lifecycle-dispatch-fixture";

const validToolNativePreContext = {
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  turnCount: 0,
  isCompletion: false,
  continuationCount: 0,
  elapsedMs: 0,
  sessionId: "session-test",
  runId: "run-test",
  toolId: "bash",
  toolInput: {},
  toolName: "bash",
};

describe("buildPolicyEngine policy ownership", () => {
  it("does not register default middleware", async () => {
    Bus.reset();
    const engine = buildPolicyEngine(makeConfig(), makeAgentBase());

    const decision = await engine.dispatchPoint("tool.native.pre", validToolNativePreContext);

    expect(decision).toMatchObject({ verdict: "allow", policyId: "agent.policy.composed" });
  });

  it("honors explicit middleware supplied by the runtime builder", async () => {
    const denyBash = mock(() => abortRun("test.deny", "test.deny"));
    const config = makeConfig({
      middleware: [
        {
          kind: "point",
          name: "test:deny-bash",
          pointIds: ["tool.native.pre"],
          effectCapabilities: { "tool.native.pre": ["run.abort"] },
          priority: 0,
          fn: denyBash,
        },
      ],
    });

    const engine = buildPolicyEngine(config, makeAgentBase());
    const decision = await engine.dispatchPoint("tool.native.pre", validToolNativePreContext);

    expect(decision).toMatchObject({
      verdict: "deny",
      policyId: "agent.policy.composed",
      reasonCodes: ["test.deny"],
    });
    expect(denyBash).toHaveBeenCalledTimes(1);
  });

  /**
   * Audit H1 regression: `buildPolicyEngine` runs once per `runAgent` call,
   * so a `kind: "factory"` middleware entry shared through one config — the
   * worker host assembles middleware ONCE and shares the same array with the
   * parent agent and every child — mints fresh closure state per run instead
   * of leaking one policy instance across all of them.
   */
  it("instantiates factory middleware per engine build (per run)", async () => {
    let instances = 0;
    const config = makeConfig({
      middleware: [
        {
          kind: "factory",
          name: "test:stateful",
          create: () => {
            instances += 1;
            let denials = 0;
            return {
              kind: "point",
              name: "test:stateful",
              pointIds: ["tool.native.pre"],
              effectCapabilities: { "tool.native.pre": ["run.abort"] },
              priority: 0,
              fn: () => {
                denials += 1;
                return denials === 1
                  ? abortRun("test.stateful", "first-call-denied")
                  : allow("test.stateful");
              },
            };
          },
        },
      ],
    });

    const runOne = buildPolicyEngine(config, makeAgentBase());
    const runTwo = buildPolicyEngine(config, makeAgentBase());
    expect(instances).toBe(2);

    const first = await runOne.dispatchPoint("tool.native.pre", validToolNativePreContext);
    // A second run (or a child agent) built from the same shared config gets
    // its own state: its first dispatch still sees a fresh counter.
    const fresh = await runTwo.dispatchPoint("tool.native.pre", validToolNativePreContext);
    const second = await runOne.dispatchPoint("tool.native.pre", validToolNativePreContext);

    expect(first.verdict).toBe("deny");
    expect(fresh.verdict).toBe("deny");
    expect(second.verdict).toBe("allow");
  });
});
