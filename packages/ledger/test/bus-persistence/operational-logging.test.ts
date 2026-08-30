import { afterEach, expect, spyOn, test } from "bun:test";
import { writeOperationalToStdout } from "../../src/bus-persistence/operational-logging.js";

const originalLevel = process.env.OPENOMNI_LOG_LEVEL;

afterEach(() => {
  if (originalLevel === undefined) {
    delete process.env.OPENOMNI_LOG_LEVEL;
  } else {
    process.env.OPENOMNI_LOG_LEVEL = originalLevel;
  }
});

test("structured operational output preserves correlation and component identity", () => {
  process.env.OPENOMNI_LOG_LEVEL = "info";
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    writeOperationalToStdout("operational.info", {
      eventId: "event-1",
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "parent-1",
      sessionId: "session-1",
      runId: "run-1",
      actorId: "resident",
      agentName: "resident",
      componentId: "resident.agent",
      componentGeneration: 4,
      pluginName: "builtin.resident",
      pluginVersion: "1.0.0",
      configRevision: 9,
      time: 1_700_000_000_000,
      component: "agent",
      msg: "agent.run.started",
      context: { model: "test-model" },
    });

    expect(write).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(write.mock.calls[0]?.[0]).trim());
    expect(line).toEqual({
      model: "test-model",
      eventId: "event-1",
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "parent-1",
      sessionId: "session-1",
      runId: "run-1",
      actorId: "resident",
      agentName: "resident",
      componentId: "resident.agent",
      componentGeneration: 4,
      pluginName: "builtin.resident",
      pluginVersion: "1.0.0",
      configRevision: 9,
      ts: 1_700_000_000_000,
      level: "info",
      pid: process.pid,
      component: "agent",
      msg: "agent.run.started",
    });
  } finally {
    write.mockRestore();
  }
});
