import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearMailbox, getMailboxDepth, sendToMailbox } from "../../src/subagent/session-mailbox";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

beforeEach(() => {
  clearMailbox(SESSION_A);
  clearMailbox(SESSION_B);
});

afterEach(() => {
  clearMailbox(SESSION_A);
  clearMailbox(SESSION_B);
});

describe("session mailbox", () => {
  it("processes 10 concurrent sends to the same session in FIFO order", async () => {
    const log: string[] = [];

    const promises = Array.from({ length: 10 }, (_, i) =>
      sendToMailbox(SESSION_A, async () => {
        log.push(`start-${i}`);
        await Promise.resolve();
        log.push(`end-${i}`);
        return i;
      }),
    );

    const results = await Promise.all(promises);

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (let i = 0; i < 10; i++) {
      expect(log[i * 2]).toBe(`start-${i}`);
      expect(log[i * 2 + 1]).toBe(`end-${i}`);
    }
  });

  it("runs different sessions in parallel", async () => {
    const DELAY = 20;
    const log: string[] = [];

    const start = Date.now();
    await Promise.all([
      sendToMailbox(SESSION_A, async () => {
        log.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, DELAY));
        log.push("a-end");
      }),
      sendToMailbox(SESSION_B, async () => {
        log.push("b-start");
        await new Promise((resolve) => setTimeout(resolve, DELAY));
        log.push("b-end");
      }),
    ]);
    const elapsed = Date.now() - start;

    // both sessions ran concurrently — total time should be ≈ DELAY, not 2×DELAY
    expect(elapsed).toBeLessThan(DELAY * 2 - 5);
    expect(log).toContain("a-start");
    expect(log).toContain("b-start");
  });

  it("error in one operation does not block subsequent operations", async () => {
    const results = await Promise.allSettled([
      sendToMailbox(SESSION_A, async () => "ok-1"),
      sendToMailbox(SESSION_A, async () => {
        throw new Error("boom");
      }),
      sendToMailbox(SESSION_A, async () => "ok-3"),
    ]);

    expect(results[0]).toMatchObject({ status: "fulfilled", value: "ok-1" });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: "ok-3" });
  });

  it("getMailboxDepth reflects pending queue length", async () => {
    let unblock: () => void;
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    const first = sendToMailbox(SESSION_A, () => blocker.then(() => "done"));
    const second = sendToMailbox(SESSION_A, async () => "queued-1");
    const third = sendToMailbox(SESSION_A, async () => "queued-2");

    // first is running, two more are in the queue
    await Promise.resolve();
    expect(getMailboxDepth(SESSION_A)).toBe(2);

    unblock?.();
    await Promise.all([first, second, third]);

    expect(getMailboxDepth(SESSION_A)).toBe(0);
  });

  it("clearMailbox removes pending entries", async () => {
    let unblock: () => void;
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    sendToMailbox(SESSION_A, () => blocker.then(() => "running"));
    const pending = sendToMailbox(SESSION_A, async () => "pending");

    await Promise.resolve();
    clearMailbox(SESSION_A);

    unblock?.();

    // The pending entry was cleared; it will never settle on its own.
    // Race with a short timeout to verify it's gone.
    const race = await Promise.race([
      pending.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(race).toBe("timeout");
  });

  it("rejects enqueue when queue is at MAX_QUEUE_DEPTH", async () => {
    // Create a blocker to keep the first item running
    let unblock: () => void;
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    // Start one item that will block
    sendToMailbox(SESSION_A, () => blocker.then(() => "running"));

    // Enqueue MAX_QUEUE_DEPTH items (these will be pending)
    const MAX_QUEUE_DEPTH = 1000;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      promises.push(sendToMailbox(SESSION_A, async () => `item-${i}`));
    }

    // Try to enqueue one more — should be rejected
    const overflow = sendToMailbox(SESSION_A, async () => "overflow");

    // Verify the overflow promise rejects
    const result = await Promise.allSettled([overflow]);
    expect(result[0].status).toBe("rejected");
    if (result[0].status === "rejected") {
      expect(result[0].reason).toBeInstanceOf(Error);
      expect(result[0].reason.message).toContain("Mailbox queue depth exceeded");
    }

    // Unblock and verify the queued items still process
    unblock?.();
    const settledResults = await Promise.allSettled(promises);
    expect(settledResults.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
