import { describe, expect, it } from "bun:test";
import { sleep } from "../../src/core/retry";

describe("Retry.sleep", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();

    await expect(sleep(5_000, controller.signal)).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("rejects when the signal aborts during sleep", async () => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 5);
    const started = Date.now();

    await expect(sleep(5_000, controller.signal)).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("removes the abort listener after normal completion", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAddEventListener = signal.addEventListener.bind(signal);
    const originalRemoveEventListener = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;

    signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      added += 1;
      return originalAddEventListener(...args);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removed += 1;
      return originalRemoveEventListener(...args);
    }) as AbortSignal["removeEventListener"];

    await sleep(1, signal);

    expect(added).toBe(1);
    expect(removed).toBe(1);
  });
});
