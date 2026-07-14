import { describe, expect, it } from "bun:test";
import { Bus } from "@openomni/session";
import { abortRun } from "../../helpers/policy-decision";
import { buildPolicyEngine } from "../../../src/core/execution/policy-engine-builder";
import { makeAgentBase, makeConfig } from "./lifecycle-dispatch-fixture";

describe("buildPolicyEngine policy ownership", () => {
  it("does not register default middleware", async () => {
    Bus.reset();
    const engine = buildPolicyEngine(makeConfig(), makeAgentBase());

    await expect(
      engine.dispatch("invoke.prepare", {
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 0,
        isCompletion: false,
        continuationCount: 0,
        elapsedMs: 0,
        toolName: "bash",
      }),
    ).resolves.toMatchObject({ verdict: "allow" });
  });

  it("honors explicit middleware supplied by the runtime builder", async () => {
    const config = makeConfig({
      middleware: [
        {
          name: "test:deny-bash",
          timing: "invoke.prepare",
          priority: 0,
          fn: () => abortRun("test.deny", "blocked"),
        },
      ],
    });

    const engine = buildPolicyEngine(config, makeAgentBase());
    await expect(
      engine.dispatch("invoke.prepare", {
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnCount: 0,
        isCompletion: false,
        continuationCount: 0,
        elapsedMs: 0,
        toolName: "bash",
      }),
    ).resolves.toMatchObject({ verdict: "deny" });
  });
});
