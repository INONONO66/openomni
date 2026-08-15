import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Execution, Ingress } from "@openomni/protocol";
import { Bus, Session, Storage, WorkerRunStateStore, WorkItemStore } from "@openomni/session";
import type { CoordinatorLike } from "../../src/ingress/coordinator-like";
import { newTraceId } from "@openomni/telemetry";

/**
 * #510 D2b pins (b) and (c) — the worker-run store stops being a live second
 * ledger for ingress worker dispatch:
 *
 *   (b) a new worker execution produces NO worker_run_state row — its run
 *       lifecycle is WorkItem attempt facts (`work_item.attempt_allocated`
 *       + `work_item.attempt_finished` on the `work:<hash>` owner stream);
 *   (c) the run's terminal extras (endedAt, error) survive a process
 *       restart — before the cutover they lived in the worker-run store's
 *       in-memory `runExtras` Map and were lost with the process.
 */

let IngressHandlers: typeof import("../../src/ingress/handlers").IngressHandlers;
let SessionBridge: typeof import("../../src/ingress/session-bridge").SessionBridge;

const originalFns: {
  storeDirectResult?: typeof import("../../src/ingress/session-bridge").SessionBridge.storeDirectResult;
} = {};

let tempDir: string;
let dbPath: string;

beforeAll(async () => {
  ({ IngressHandlers } = await import("../../src/ingress/handlers"));
  ({ SessionBridge } = await import("../../src/ingress/session-bridge"));
  originalFns.storeDirectResult = SessionBridge.storeDirectResult;
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openomni-worker-run-cutover-"));
  dbPath = join(tempDir, "storage.db");
  Storage.reset();
  Storage.initialize({ dbPath });
  Bus.reset();
  SessionBridge.storeDirectResult = mock(() => undefined);
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalFns.storeDirectResult) {
    SessionBridge.storeDirectResult = originalFns.storeDirectResult;
  }
});

afterAll(() => {
  mock.restore();
});

function createSession(): string {
  return Session.create({
    title: "worker-run cutover",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
}

function workerEvent(id: string, parentSessionId?: string): Ingress.DirectEvent {
  return {
    id,
    traceId: "trace-test",
    surface: "tui",
    mode: "direct",
    payload: "run the cutover task",
    target: { kind: "worker" },
    ...(parentSessionId ? { meta: { actor: { sessionId: parentSessionId } } } : {}),
    agent: {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    },
  };
}

function factTypesOfWorkStream(hash: string): string[] {
  const ledger = Storage.get().ledger;
  if (!ledger) throw new Error("ledger sub-adapter missing");
  return [
    ...ledger.factsByType("work_item.attempt_allocated"),
    ...ledger.factsByType("work_item.attempt_finished"),
  ]
    .filter((fact) => fact.streamId === `work:${hash}`)
    .map((fact) => fact.type);
}

describe("worker-run cutover (#510 D2b)", () => {
  it("pin (b): a new worker execution produces no worker_run row — attempt facts only", async () => {
    const sessionId = createSession();
    const parentSessionId = createSession();
    let dispatchedRunId: string | undefined;
    const coordinator: CoordinatorLike = {
      async dispatch(_sessionId: string, request: Execution.Request) {
        dispatchedRunId = request.runId;
        // The executor acts strictly AFTER the attempt identity is durable.
        const item = WorkItemStore.list().find(
          (candidate) => candidate.workerRunId === request.runId,
        );
        if (!item) throw new Error("attempt-run WorkItem not found at dispatch time");
        expect(factTypesOfWorkStream(item.hash)).toContain("work_item.attempt_allocated");
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "succeeded" as const,
          output: "done",
          finishReason: "stop",
        };
      },
    };

    await IngressHandlers.handleDirect({
      sessionId,
      traceContext: { traceId: newTraceId() },
      event: workerEvent("event-cutover-no-rows", parentSessionId),
      coordinator,
    });

    if (!dispatchedRunId) throw new Error("coordinator dispatch did not run");
    // NO worker_run_state row exists for the new execution.
    expect(WorkerRunStateStore.get(sessionId, dispatchedRunId)).toBeUndefined();
    expect(WorkerRunStateStore.listBySession(sessionId)).toHaveLength(0);

    // The run lifecycle is attempt facts on the work stream.
    const item = WorkItemStore.list().find(
      (candidate) => candidate.workerRunId === dispatchedRunId,
    );
    if (!item) throw new Error("attempt-run WorkItem missing after dispatch");
    expect(item.workSessionId).toBe(sessionId);
    expect(item.originSessionId).toBe(parentSessionId);
    expect(item.currentAttemptId).toBeDefined();
    expect(item.attemptTerminal).toMatchObject({
      attemptId: item.currentAttemptId,
      outcome: "succeeded",
    });
    expect(factTypesOfWorkStream(item.hash)).toEqual([
      "work_item.attempt_allocated",
      "work_item.attempt_finished",
    ]);
  });

  it("pin (c): terminal extras (endedAt, error) survive a process restart", async () => {
    const sessionId = createSession();
    let dispatchedRunId: string | undefined;
    const before = Date.now();
    const coordinator: CoordinatorLike = {
      async dispatch(_sessionId: string, request: Execution.Request) {
        dispatchedRunId = request.runId;
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "failed" as const,
          error: "executor exploded",
          finishReason: "error",
        };
      },
    };

    await expect(
      IngressHandlers.handleDirect({
        sessionId,
        traceContext: { traceId: newTraceId() },
        event: workerEvent("event-cutover-restart"),
        coordinator,
      }),
    ).rejects.toThrow("Coordinator dispatch failed");
    if (!dispatchedRunId) throw new Error("coordinator dispatch did not run");

    // Simulate a process restart: drop every in-memory remainder and rebuild
    // from the same database file.
    Storage.reset();
    Storage.initialize({ dbPath });

    const item = WorkItemStore.list().find(
      (candidate) => candidate.workerRunId === dispatchedRunId,
    );
    if (!item) throw new Error("attempt-run WorkItem missing after restart");
    expect(item.attemptTerminal?.outcome).toBe("failed");
    expect(item.attemptTerminal?.error).toContain("executor exploded");
    expect(item.attemptTerminal?.endedAt).toBeGreaterThanOrEqual(before);
    // And still no worker_run_state row after the restart.
    expect(WorkerRunStateStore.listBySession(sessionId)).toHaveLength(0);
  });
});
