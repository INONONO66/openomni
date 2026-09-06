import { describe, expect, it, spyOn } from "bun:test";
import { Retry } from "@openomni/llm";

import { abortError, isAbort } from "../../src/core/retry";

describe("Retry.sleep", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    // "Immediately" means no timer was ever scheduled. That is the exact
    // observable; the old `elapsed < 100` bound was a proxy a loaded machine
    // could fail while a real 50ms regression still passed it.
    const timeout = spyOn(globalThis, "setTimeout");

    try {
      await expect(Retry.sleep(5_000, controller.signal)).rejects.toThrow(/aborted/i);
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects when the signal aborts during sleep", async () => {
    const controller = new AbortController();
    const sleeping = Retry.sleep(5_000, controller.signal);

    // The sleep registered its timer and abort listener synchronously, so the
    // abort races nothing: no 5ms timer and no wall-clock bound needed. The
    // rejection identity IS the proof that the abort cut the pending sleep
    // short - a 5s sleep that ran to completion resolves, it does not reject.
    controller.abort();

    await expect(sleeping).rejects.toThrow(/aborted/i);
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

    let fireTimer: (() => void) | undefined;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      if (typeof callback === "function") fireTimer = callback;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      const sleeping = Retry.sleep(1, signal);
      expect(added).toBe(1);
      if (fireTimer === undefined) expect.unreachable("Expected sleep to schedule a timer");
      fireTimer();
      await sleeping;
      expect(removed).toBe(1);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("isAbort (audit M4)", () => {
  it("recognizes an aborted signal regardless of the error message", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(new Error("connection timeout"), controller.signal)).toBe(true);
  });

  it("recognizes the typed abort error without a signal", () => {
    expect(isAbort(abortError(), undefined)).toBe(true);
    expect(abortError().name).toBe("AbortError");
  });

  it("does NOT classify by message substring: a tool error mentioning 'aborted' is not an abort", () => {
    const controller = new AbortController();
    expect(isAbort(new Error("tool run aborted by remote host"), controller.signal)).toBe(false);
  });
});
