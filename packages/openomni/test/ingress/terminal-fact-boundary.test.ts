import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Operational, type Ingress } from "@openomni/protocol";
import { Session, Storage, WorkItemAttemptRun } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { IngressHandlers } from "../../src/ingress/handlers";
import type { CoordinatorLike } from "../../src/ingress/coordinator-like";

function createSession(): string {
  return Session.create({
    traceId: "trace-test",
    title: "Terminal Fact Boundary",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
}

function workerEvent(sessionId: string): Ingress.ResolvedInboundEvent {
  return {
    id: "event-boundary-1",
    traceId: "trace-test",
    surface: "tui",
    mode: "direct",
    payload: "do the thing",
    target: { kind: "worker", sessionId },
    // `background` is a declared ActivationMetadata field (#500 A2).
    activation: { background: true },
    agent: { model: { provider: "anthropic", id: "claude-3-haiku-20240307" } },
  };
}

/**
 * Arms WorkItemAttemptRun.finish to throw the store's BUSY error: the
 * attempt-run setup writes must succeed, only the IIFE's deferred terminal
 * fact write fails — matching the #670 review PoC.
 */
function armableBusyFinish(): { arm: () => void; restore: () => void } {
  const original = WorkItemAttemptRun.finish;
  let armed = false;
  WorkItemAttemptRun.finish = async (...args: Parameters<typeof original>) => {
    if (!armed) return original(...args);
    const busy = new Error("WorkItem storage busy: wi_test — database is locked") as Error & {
      code: string;
    };
    busy.code = "unavailable";
    throw busy;
  };
  return {
    arm: () => {
      armed = true;
    },
    restore: () => {
      WorkItemAttemptRun.finish = original;
    },
  };
}

async function flushBackground(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("terminal-fact failures record, never kill (#606 review)", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  it("a busy interrupted-fact write in the background IIFE records instead of rejecting", async () => {
    const sessionId = createSession();
    const errors: Array<Record<string, unknown>> = [];
    Bus.observe((event, data) => {
      if (event.name === Operational.Events.Error.name)
        errors.push(data as Record<string, unknown>);
    });
    // The dispatch waits for the test's signal so the busy arm is in place
    // BEFORE the IIFE's failure path runs its terminal fact write.
    let releaseDispatch: () => void = () => undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const coordinator: CoordinatorLike = {
      dispatch: async () => {
        await dispatchGate;
        throw new Error("worker exploded");
      },
    };
    const busy = armableBusyFinish();
    try {
      // Pin: pre-fix this chain rejected the void IIFE — an unhandled
      // rejection that kills the whole process under bun (#670 review PoC).
      const result = await IngressHandlers.handleDirect({
        sessionId,
        traceContext: { traceId: "trace-boundary" },
        event: workerEvent(sessionId),
        coordinator,
      });
      expect(result).toMatchObject({ result: { finishReason: "background" } });
      busy.arm();
      releaseDispatch();
      await flushBackground();
    } finally {
      busy.restore();
    }
    expect(
      errors.some(
        (error) =>
          error.msg === "run terminal fact write failed (interrupted)" &&
          error.traceId === "trace-boundary",
      ),
    ).toBe(true);
  });

  it("a busy finish on the SUCCESS path records — never an interrupted fact", async () => {
    const sessionId = createSession();
    const errors: string[] = [];
    Bus.observe((event, data) => {
      if (event.name === Operational.Events.Error.name) {
        errors.push(String((data as { msg?: unknown }).msg));
      }
    });
    let releaseDispatch: () => void = () => undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const coordinator: CoordinatorLike = {
      dispatch: async () => {
        await dispatchGate;
        return { runId: "run-boundary", sessionId, status: "succeeded" as const, output: "done" };
      },
    };
    const busy = armableBusyFinish();
    try {
      const result = await IngressHandlers.handleDirect({
        sessionId,
        traceContext: { traceId: "trace-boundary" },
        event: workerEvent(sessionId),
        coordinator,
      });
      expect(result).toMatchObject({ result: { finishReason: "background" } });
      busy.arm();
      releaseDispatch();
      await flushBackground();
    } finally {
      busy.restore();
    }
    expect(errors).toContain("run terminal fact write failed (finish)");
    expect(errors).not.toContain("run terminal fact write failed (interrupted)");
  });
});
