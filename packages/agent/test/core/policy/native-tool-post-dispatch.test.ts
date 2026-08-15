import { expect, it } from "bun:test";
import { PolicyDecision, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createToolExecutor } from "../../../src/core/execution/tools";
import { PolicyEngine } from "../../../src/core/policy";

/**
 * The agent-side half of what used to be an idle-nudge test: the executor
 * reaches `tool.native.post`, at the `invoke.result` timing, exactly once per
 * native tool call. Which policy sits there is the product's choice (D5), so
 * a stand-in registration is the honest subject.
 */
it("dispatches at the canonical native tool result point", async () => {
  let observed = 0;
  const engine = PolicyEngine.create();
  engine.register({
    kind: "point",
    name: "test:native-post-observer",
    pointIds: ["tool.native.post"],
    effectCapabilities: { "tool.native.post": [] },
    priority: 0,
    fn: (ctx) => {
      if (ctx.pointId === "tool.native.post" && ctx.timing === "invoke.result") observed++;
      return PolicyDecision.allow({ policyId: "test.native-post-observer" });
    },
  });

  const executor = createToolExecutor({
    events: Bus,
    traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
    engine,
    toolExecutor: async (call) => ({
      id: "result-native",
      toolCallId: call.id,
      output: "ok",
      isError: false,
    }),
  });
  const call: Tool.Call = { id: "call-native", tool: "bash", input: { command: "ls" } };

  await executor(call);

  expect(observed).toBe(1);
});
