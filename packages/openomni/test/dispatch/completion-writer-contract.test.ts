import { describe, expect, test } from "bun:test";
import { createDefaultDispatchRuntime } from "../../src/index";
import type { CompletionAdmissionService } from "../../src/work-item/completion-admission.js";

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

  test("names the missing recovery capability of an injected completion service", async () => {
    const unsupported = () => {
      throw new Error("not under test");
    };
    const injected: CompletionAdmissionService = {
      requestCompletion: unsupported,
      resumeCompletion: unsupported,
      reserveRequest: unsupported,
      assertReservationLease: unsupported,
    };
    const runtime = createDefaultDispatchRuntime({ completionAdmissionService: injected });

    const recovery = runtime.recoverRecordedWorkItemCompletions();

    expect(recovery).toBeInstanceOf(Promise);
    await expect(recovery).rejects.toThrow(
      "injected completion service does not implement recovery",
    );
  });
});
