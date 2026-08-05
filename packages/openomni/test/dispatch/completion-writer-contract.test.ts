import { describe, expect, test } from "bun:test";
import { createDefaultDispatchRuntime } from "../../src/index";

describe("default dispatch completion writer contract", () => {
  test("rejects submission and recovery through Promises when the writer is unavailable", async () => {
    const runtime = createDefaultDispatchRuntime();

    const submission = runtime.submitActorWorkItemCompletion(
      {} as Parameters<typeof runtime.submitActorWorkItemCompletion>[0],
    );
    const recovery = runtime.recoverRecordedWorkItemCompletions();

    expect(submission).toBeInstanceOf(Promise);
    expect(recovery).toBeInstanceOf(Promise);
    await expect(submission).rejects.toThrow("completion writer is unavailable");
    await expect(recovery).rejects.toThrow("completion writer is unavailable");
  });
});
