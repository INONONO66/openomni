import { describe, expect, it } from "bun:test";
import { Bus } from "../../src/index";
import { createCompactionPolicy } from "../../src/compaction/policy";

/**
 * #702 rider: the sessionless skip is a recorded reason, not a silent allow.
 * run.completion.pre is fail-closed; the guard exists so a dispatcher that
 * forgot the session degrades the turn instead of killing the run — but only
 * if the skip stays visible.
 */
describe("compaction policy skip reasons", () => {
  it("records compaction_skipped_no_session when the context carries no session", async () => {
    const registration = createCompactionPolicy({
      contextWindowTokens: 100,
      events: Bus,
      priority: 900,
    }).create();
    const decision = await registration.fn({
      pointId: "run.completion.pre",
      timing: "pre" as never,
      traceContext: { traceId: "trace-skip-test" } as never,
      messages: [{ info: { id: "m1" }, parts: [] }] as never,
      contextTokens: 99,
      contextWindowTokens: 100,
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
      turnCount: 1,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 0,
    } as never);
    expect(decision.verdict).toBe("allow");
    expect((decision as { reasonCodes?: string[] }).reasonCodes).toEqual([
      "compaction_skipped_no_session",
    ]);
  });
});
