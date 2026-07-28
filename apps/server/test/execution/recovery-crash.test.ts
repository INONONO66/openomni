import { describe, expect, test } from "bun:test";
import { runRecovery } from "../../src/bootstrap/recovery";
import {
  recoverInterruptedRuns,
  type InterruptedRunProjection,
  type RunRecoveryService,
} from "../../src/execution/recovery";

type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

type Row = InterruptedRunProjection & { status: RunStatus };
type RecoveryCall = {
  readonly sessionId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly reason: string;
};

function recoveryService(
  rows: readonly Row[],
  options: { unchanged?: ReadonlySet<string>; calls?: RecoveryCall[] } = {},
): RunRecoveryService {
  return {
    queries: {
      interruptedRuns: async () =>
        rows.filter((row) => ["starting", "running", "waiting_input"].includes(row.status)),
    },
    commands: {
      interruptRun: async (input) => {
        options.calls?.push(input);
        return options.unchanged?.has(input.runId) ? "unchanged" : "recovered";
      },
    },
  };
}

describe("recoverInterruptedRuns", () => {
  test.each([
    "starting",
    "running",
    "waiting_input",
  ] as const)("recovers a %s attempt through the authoritative recovery command", async (status) => {
    const calls: RecoveryCall[] = [];
    const result = await recoverInterruptedRuns(
      recoveryService([{ sessionId: `session-${status}`, runId: `run-${status}`, status }], {
        calls,
      }),
    );

    expect(result).toEqual({ recovered: 1, sessions: [`session-${status}`] });
    expect(calls).toEqual([
      {
        sessionId: `session-${status}`,
        runId: `run-${status}`,
        requestId: `run-recovery:run-${status}`,
        reason: "coordinator restarted: run interrupted",
      },
    ]);
  });

  test("the authoritative projection excludes queued and terminal attempts", async () => {
    const calls: RecoveryCall[] = [];
    const statuses = ["queued", "succeeded", "failed", "cancelled", "interrupted"] as const;
    const result = await recoverInterruptedRuns(
      recoveryService(
        statuses.map((status) => ({
          sessionId: `session-${status}`,
          runId: `run-${status}`,
          status,
        })),
        { calls },
      ),
    );

    expect(result).toEqual({ recovered: 0, sessions: [] });
    expect(calls).toEqual([]);
  });

  test("does not count a run changed by a concurrent writer", async () => {
    const calls: RecoveryCall[] = [];
    const result = await recoverInterruptedRuns(
      recoveryService([{ sessionId: "session-race", runId: "run-race", status: "running" }], {
        calls,
        unchanged: new Set(["run-race"]),
      }),
    );

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ recovered: 0, sessions: [] });
  });

  test("deduplicates sessions while preserving authoritative projection order", async () => {
    const result = await recoverInterruptedRuns(
      recoveryService([
        { sessionId: "session-b", runId: "run-b1", status: "starting" },
        { sessionId: "session-a", runId: "run-a", status: "running" },
        { sessionId: "session-b", runId: "run-b2", status: "waiting_input" },
      ]),
    );

    expect(result).toEqual({ recovered: 3, sessions: ["session-b", "session-a"] });
  });

  test("runRecovery propagates an authoritative run recovery failure before message recovery", async () => {
    let messagesQueried = false;
    const failure = new Error("run recovery unavailable");

    await expect(
      runRecovery(
        {
          runs: {
            queries: { interruptedRuns: async () => [{ sessionId: "session-1", runId: "run-1" }] },
            commands: { interruptRun: async () => Promise.reject(failure) },
          },
          messages: {
            queries: {
              interruptedMessages: async () => {
                messagesQueried = true;
                return [];
              },
            },
            commands: { reconcileInterruptedMessage: async () => undefined },
          },
        },
        "trace-recovery",
      ),
    ).rejects.toBe(failure);
    expect(messagesQueried).toBe(false);
  });
});
