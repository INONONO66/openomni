import { expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { createToolExecutor } from "../../../src/core/execution/tool-executor";
import { PolicyEngine } from "../../../src/core/policy";
import type { CanonicalPolicyRegistration } from "../../../src/core/policy";
import { createIdleNudgePolicy } from "../../../src/core/policy/builtin/idle-nudge";

it("dispatches idle-nudge at the canonical native tool result point", async () => {
  // Given
  const idleNudge = createIdleNudgePolicy({ idleThresholdMs: -1 });
  let postToolUseCallCount = 0;
  const originalFn = idleNudge.fn;
  const observedIdleNudge: CanonicalPolicyRegistration = {
    ...idleNudge,
    fn: (ctx) => {
      if (ctx.pointId === "tool.native.post" && ctx.timing === "invoke.result") {
        postToolUseCallCount++;
      }
      return originalFn(ctx);
    },
  };
  const engine = PolicyEngine.create();
  engine.register(observedIdleNudge);
  const executor = createToolExecutor({
    engine,
    toolExecutor: async (call) => ({
      id: "result-idle",
      toolCallId: call.id,
      output: "ok",
      isError: false,
    }),
  });
  const call: Tool.Call = { id: "call-idle", tool: "bash", input: { command: "ls" } };

  // When
  await executor(call);

  // Then
  expect(postToolUseCallCount).toBe(1);
});
