import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { abortRun } from "../../helpers/policy-decision";
import { buildPolicyEngine } from "../../../src/core/execution/runner";
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
});
