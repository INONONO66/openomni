import { afterEach, describe, expect, test } from "bun:test";
import { WorkerDeliveryError } from "../error";
import { resolveRestartDelay, waitForSupervisorReady } from "./supervisor-process";

// buildWorkerEnv coverage (fixture keys off the production allowlist, opt-in
// via extraEnvKeys) lives in test/worker-supervision/worker-env.test.ts.

afterEach(() => {
  delete process.env.OPENOMNI_WORKER_RESTART_BASE_DELAY_MS;
});

describe("waitForSupervisorReady typed rejections (#audit M6)", () => {
  test("readiness timeout rejects with worker_not_ready", async () => {
    try {
      await waitForSupervisorReady(3, () => false, 0);
      throw new Error("expected waitForSupervisorReady to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerDeliveryError);
      expect((error as InstanceType<typeof WorkerDeliveryError>).data.code).toBe(
        "worker_not_ready",
      );
    }
  });

  test("a stopping supervisor rejects with worker_stopped", async () => {
    try {
      await waitForSupervisorReady(
        3,
        () => false,
        5_000,
        () => true,
      );
      throw new Error("expected waitForSupervisorReady to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerDeliveryError);
      expect((error as InstanceType<typeof WorkerDeliveryError>).data.code).toBe("worker_stopped");
    }
  });
});

describe("resolveRestartDelay backoff (#audit M2)", () => {
  test("doubles from the base delay and caps at 30s", () => {
    expect(resolveRestartDelay(1)).toBe(1_000);
    expect(resolveRestartDelay(2)).toBe(2_000);
    expect(resolveRestartDelay(5)).toBe(16_000);
    expect(resolveRestartDelay(10)).toBe(30_000);
  });

  test("honors the env base-delay override used by crash-loop tests", () => {
    process.env.OPENOMNI_WORKER_RESTART_BASE_DELAY_MS = "10";
    expect(resolveRestartDelay(1)).toBe(10);
    expect(resolveRestartDelay(3)).toBe(40);
  });
});
