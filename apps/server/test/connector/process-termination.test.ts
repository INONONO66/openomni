import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConnectorProcess } from "../../src/connector/process";

/**
 * #517 regression — a TERM-resistant descendant retaining the inherited
 * stdout/stderr pipes must never keep `runConnectorProcess` pending past the
 * bounded termination flow (group SIGTERM → graceful window → group SIGKILL).
 * Readiness is an exact signal (the connector writes its descendant's pid to
 * a marker file), never a fixed sleep.
 */

const TEMPLATE_VALUES = {
  prompt: "noop",
  worktree: "/tmp",
  runId: "run-termination",
  sessionId: "sess-termination",
} as const;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * On Linux a SIGKILLed, init-reparented descendant lingers as a ZOMBIE for a
 * beat — `kill(pid, 0)` still succeeds for zombies even though the process
 * is dead and its pipes are closed (the group probe correctly reports the
 * group gone, which is why the dispatch settled). Bounded poll until init
 * reaps it; the assertion is "dead", not "already reaped at settle-instant".
 */
async function expectProcessGone(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await Bun.sleep(20);
  }
  expect(processAlive(pid)).toBe(false);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`readiness marker never appeared: ${path}`);
}

/** Parent dies on TERM; the backgrounded child ignores TERM and keeps the inherited pipes open. */
function resistantConnectorScript(markerPath: string): string {
  return [
    `bash -c 'trap "" TERM; while :; do sleep 0.05; done' &`,
    "child=$!",
    `echo "$child" > "${markerPath}"`,
    'wait "$child"',
  ].join("\n");
}

describe("connector process-group termination (#517)", () => {
  it("settles a timed-out dispatch and reaps a TERM-resistant descendant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openomni-conn-term-"));
    const marker = join(dir, "ready");
    try {
      const pending = runConnectorProcess(
        // Generous timeout: the marker must be observed while the connector
        // is still alive even on a badly loaded CI runner.
        { command: "bash", args: ["-c", resistantConnectorScript(marker)], timeoutMs: 2_000 },
        undefined,
        undefined,
        TEMPLATE_VALUES,
        {},
        undefined,
        "resident-session",
      );
      await waitForFile(marker, 5_000);
      const descendantPid = Number(readFileSync(marker, "utf-8").trim());
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(processAlive(descendantPid)).toBe(true);

      const result = await pending; // pre-fix: pending forever on the held pipes
      expect(result.outcome.status).toBe("interrupted");
      expect(result.outcome.interruptionReason).toBe("timeout");
      // The group is gone when dispatch settles — the descendant included
      // (zombie-reap tolerated, see expectProcessGone).
      await expectProcessGone(descendantPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("preserves the first interruption reason under concurrent timeout signals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openomni-conn-term-"));
    const marker = join(dir, "ready");
    try {
      const pending = runConnectorProcess(
        {
          command: "bash",
          args: ["-c", resistantConnectorScript(marker)],
          // Both fire while the graceful window is still open; the first
          // (stall) must win the recorded reason.
          timeoutMs: 350,
          stallTimeoutMs: 200,
        },
        undefined,
        undefined,
        TEMPLATE_VALUES,
        {},
        undefined,
        "resident-session",
      );
      await waitForFile(marker, 5_000);
      const descendantPid = Number(readFileSync(marker, "utf-8").trim());

      const result = await pending;
      expect(result.outcome.status).toBe("interrupted");
      expect(result.outcome.interruptionReason).toBe("stall_timeout");
      await expectProcessGone(descendantPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("classifies a natural exit deterministically when no interruption fired", async () => {
    const succeeded = await runConnectorProcess(
      { command: "bash", args: ["-c", "echo done"], timeoutMs: 10_000 },
      undefined,
      undefined,
      TEMPLATE_VALUES,
      {},
      undefined,
      "resident-session",
    );
    expect(succeeded.outcome.status).toBe("succeeded");
    expect(succeeded.outcome.exitCode).toBe(0);
    expect(succeeded.outcome.stdout).toContain("done");

    const failed = await runConnectorProcess(
      { command: "bash", args: ["-c", "exit 3"], timeoutMs: 10_000 },
      undefined,
      undefined,
      TEMPLATE_VALUES,
      {},
      undefined,
      "resident-session",
    );
    expect(failed.outcome.status).toBe("failed");
    expect(failed.outcome.exitCode).toBe(3);
  });
});
