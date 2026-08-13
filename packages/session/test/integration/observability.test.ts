import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { AgentExecution, LlmCall, ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { BusPersistence } from "../../src/bus-persistence/index.js";
import { BusQuery } from "../../src/bus-persistence/query.js";
import { Session } from "../../src/session/index.js";
import { Storage } from "../../src/storage/storage.js";
import "../../src/storage/initialize.js";

function db(): Database {
  return (Storage.getAdapter() as unknown as { readonly db: Database }).db;
}

function createSession(title = "test"): ReturnType<typeof Session.create> {
  return Session.create({
    title,
    model: { providerID: "test", modelID: "test-model" },
  });
}

describe("Observability Pipeline Integration", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
    BusPersistence.start();
  });

  afterEach(() => {
    BusPersistence.stop();
    Bus.reset();
    Storage.reset();
  });

  describe("end-to-end event pipeline", () => {
    test("publishes events and queries them via BusQuery", async () => {
      const session = createSession("pipeline");
      const sessionId = session.id;
      const runId = "run-pipeline-1";
      const time = Date.UTC(2026, 4, 10, 12, 0, 0);

      Bus.publish(AgentExecution.TurnStart, {
        traceId: "t1",
        sessionId,
        runId,
        time,
        turnIndex: 0,
      });
      Bus.publish(LlmCall.Started, {
        traceId: "t2",
        sessionId,
        time: time + 10,
        provider: "anthropic",
        model: "claude-4",
        messageCount: 5,
        toolCount: 2,
      });
      Bus.publish(LlmCall.Completed, {
        traceId: "t3",
        sessionId,
        time: time + 200,
        provider: "anthropic",
        model: "claude-4",
        durationMs: 190,
        inputTokens: 1000,
        outputTokens: 500,
        finishReason: "end_turn",
      });
      Bus.publish(ToolExecution.Started, {
        traceId: "t4",
        sessionId,
        runId,
        time: time + 300,
        toolCallId: "tc-1",
        toolName: "read_file",
      });
      Bus.publish(ToolExecution.Completed, {
        traceId: "t5",
        sessionId,
        runId,
        time: time + 500,
        toolCallId: "tc-1",
        toolName: "read_file",
        durationMs: 200,
        isError: false,
      });
      Bus.publish(AgentExecution.TurnComplete, {
        traceId: "t6",
        sessionId,
        runId,
        time: time + 600,
        turnIndex: 0,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      });

      await BusPersistence.flush();

      const sessionEvents = await BusQuery.listBySession(sessionId);
      expect(sessionEvents).toHaveLength(4);

      const stats = await BusQuery.getStats(sessionId);
      expect(stats.totalEvents).toBe(4);
      expect(stats.byCategory.agent).toBe(1);
      expect(stats.byCategory.llm).toBe(1);
      expect(stats.byCategory.tool).toBe(1);
      expect(stats.byCategory.session).toBe(1);

      const runEvents = await BusQuery.listByRun(runId);
      expect(runEvents.map((event) => event.eventType).sort()).toEqual([
        "agent.turn.complete",
        "tool.execution.completed",
      ]);
    });
  });

  describe("WorkerRun history without EventLog", () => {
    test("reads frozen worker run rows via the history query", async () => {
      const session = createSession("worker-run");
      const sessionId = session.id;
      const runId = "run-wr-1";

      // The worker-run store is frozen (#510 D2b) — the historical row is
      // seeded at the adapter layer, exactly as pre-freeze rows persist.
      const workerRunAdapter = Storage.getAdapter().workerRunState;
      if (!workerRunAdapter) throw new Error("workerRunState sub-adapter missing");
      workerRunAdapter.create(sessionId, {
        runId,
        agentName: "worker",
        status: "succeeded",
        title: "Test Worker",
        prompt: "Do the thing",
      });

      const history = await BusQuery.getWorkerRunHistory(sessionId);
      expect(history).toHaveLength(1);
      expect(history[0].runId).toBe(runId);
      expect(history[0].status).toBe("succeeded");

      const eventLogCount = db().query("SELECT COUNT(*) as count FROM event_log").get() as {
        count: number;
      } | null;
      if (eventLogCount) {
        expect(eventLogCount.count).toBe(0);
      }
    });
  });

  describe("session cascade delete", () => {
    test("removing a session cascades to bus_event rows", async () => {
      const session = createSession("cascade");
      const sessionId = session.id;

      Bus.publish(LlmCall.Completed, {
        traceId: "t-cascade",
        sessionId,
        time: Date.now(),
        provider: "openai",
        model: "gpt-4",
        durationMs: 300,
        inputTokens: 10,
        outputTokens: 5,
        finishReason: "end_turn",
      });

      await BusPersistence.flush();

      const beforeCount = db()
        .query("SELECT COUNT(*) as count FROM bus_event WHERE session_id = ?")
        .get(sessionId) as { count: number };
      expect(beforeCount.count).toBe(2);

      Storage.getAdapter().session.remove(sessionId);

      const afterCount = db()
        .query("SELECT COUNT(*) as count FROM bus_event WHERE session_id = ?")
        .get(sessionId) as { count: number };
      expect(afterCount.count).toBe(0);
    });
  });

  describe("multi-session isolation", () => {
    test("events are correctly scoped per session", async () => {
      const sessionA = createSession("session-a");
      const sessionB = createSession("session-b");

      Bus.publish(AgentExecution.TurnStart, {
        traceId: "a1",
        sessionId: sessionA.id,
        time: Date.now(),
        turnIndex: 0,
      });
      Bus.publish(LlmCall.Started, {
        traceId: "a2",
        sessionId: sessionA.id,
        time: Date.now(),
        provider: "anthropic",
        model: "claude-4",
        messageCount: 3,
        toolCount: 1,
      });
      Bus.publish(AgentExecution.TurnComplete, {
        traceId: "a3",
        sessionId: sessionA.id,
        time: Date.now(),
        turnIndex: 0,
        usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      });

      Bus.publish(LlmCall.Started, {
        traceId: "b1",
        sessionId: sessionB.id,
        time: Date.now(),
        provider: "openai",
        model: "gpt-4",
        messageCount: 2,
        toolCount: 0,
      });
      Bus.publish(LlmCall.Completed, {
        traceId: "b2",
        sessionId: sessionB.id,
        time: Date.now(),
        provider: "openai",
        model: "gpt-4",
        durationMs: 300,
        inputTokens: 400,
        outputTokens: 100,
        finishReason: "end_turn",
      });

      await BusPersistence.flush();

      const eventsA = await BusQuery.listBySession(sessionA.id);
      expect(eventsA).toHaveLength(2);

      const eventsB = await BusQuery.listBySession(sessionB.id);
      expect(eventsB).toHaveLength(2);

      const statsA = await BusQuery.getStats(sessionA.id);
      expect(statsA.totalEvents).toBe(2);

      const statsB = await BusQuery.getStats(sessionB.id);
      expect(statsB.totalEvents).toBe(2);
    });
  });
});
