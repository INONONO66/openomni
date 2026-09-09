import { describe, expect, it } from "bun:test";
import { CompactionSession } from "../../../src/compaction/speculate";
import { resolveCompactionGeometry } from "../../../src/compaction/geometry";
import { applyCompaction } from "../../../src/core/execution/turn-compaction";
import { createRunState, recordCallContext } from "../../../src/core/execution/state";
import type { ChatAgentConfig } from "../../../src/core/types";
import { RunEvents } from "../../../src/core/execution/events";
import { Bus } from "../../../src/index";
import { captureBusEvents } from "../../helpers/bus-event";
import { textMessage } from "../../helpers/messages";
import { runInput } from "../../helpers/run-input";

const WINDOW = 1000;

function config(): ChatAgentConfig {
  return {
    events: Bus,
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    compaction: { contextWindowTokens: WINDOW, protectRecentMessages: 1 },
  };
}

function inFlightSession(started: Promise<void>): CompactionSession {
  const session = new CompactionSession({
    protectRecentMessages: 1,
    summarize: async () => {
      await started;
      return "summary";
    },
  });
  session.prepare(
    [
      textMessage("assistant", "evidence ".repeat(100), "session", "first"),
      textMessage("user", "tail", "session", "last"),
    ],
    70,
    60,
    WINDOW,
  );
  return session;
}

describe("compaction apply seam deferral", () => {
  it("defers the threshold trigger while a speculative cut is in flight below grace", async () => {
    const release = Promise.withResolvers<void>();
    const session = inFlightSession(release.promise);
    expect(session.inFlight()).toBe(true);
    const state = createRunState(runInput([{ role: "user", content: "hi" }]));
    const geometry = resolveCompactionGeometry({ contextWindowTokens: WINDOW });
    recordCallContext(state, geometry.graceTokens - 1);
    const started = captureBusEvents(RunEvents.CompactionStarted);
    try {
      const outcome = await applyCompaction(
        state,
        config(),
        { traceId: "trace", sessionId: state.sessionId, runId: "run", actorId: "actor" },
        session,
        "threshold",
      );
      expect(outcome).toBe("deferred");
      expect(started.events).toHaveLength(0);
    } finally {
      started.unsubscribe();
      release.resolve();
      await session.settled();
    }
  });

  it("runs the merge once the measured window reaches grace even with a cut in flight", async () => {
    const release = Promise.withResolvers<void>();
    const session = inFlightSession(release.promise);
    const state = createRunState(runInput([{ role: "user", content: "hi" }]));
    const geometry = resolveCompactionGeometry({ contextWindowTokens: WINDOW });
    recordCallContext(state, geometry.graceTokens);
    const started = captureBusEvents(RunEvents.CompactionStarted);
    try {
      const outcome = await applyCompaction(
        state,
        config(),
        { traceId: "trace", sessionId: state.sessionId, runId: "run", actorId: "actor" },
        session,
        "threshold",
      );
      await started.done;
      expect(outcome).toBe("none");
      expect(started.events[0]?.trigger).toBe("threshold");
    } finally {
      started.unsubscribe();
      release.resolve();
      await session.settled();
    }
  });
});
