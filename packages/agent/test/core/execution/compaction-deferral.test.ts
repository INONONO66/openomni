import { describe, expect, it } from "bun:test";
import { CompactionSession } from "../../../src/compaction/speculate";
import { applyThreshold, stateAtGrace } from "../../helpers/compaction-seam";
import type { ChatAgentConfig } from "../../../src/core/types";
import { RunEvents } from "../../../src/core/execution/events";
import { Bus } from "../../../src/index";
import { captureBusEvents } from "../../helpers/bus-event";
import { textMessage } from "../../helpers/messages";

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
    const state = stateAtGrace(WINDOW, -1);
    const started = captureBusEvents(RunEvents.CompactionStarted);
    try {
      const outcome = await applyThreshold(state, config(), session);
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
    const state = stateAtGrace(WINDOW, 0);
    const started = captureBusEvents(RunEvents.CompactionStarted);
    try {
      const outcome = await applyThreshold(state, config(), session);
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
