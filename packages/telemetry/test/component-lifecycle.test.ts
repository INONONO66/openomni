import { expect, test } from "bun:test";
import { Component } from "@openomni/protocol";
import { collector, scope } from "@openomni/telemetry";

test("component lifecycle observations share one scoped identity", () => {
  const sink = collector();
  let eventId = 0;
  const observation = scope(
    {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      sessionId: "session-1",
      runId: "run-1",
      actorId: "resident",
      agentName: "resident",
      componentId: "resident.agent",
      componentGeneration: 2,
    },
    sink,
    {
      now: () => 1_700_000_000_000,
      newEventId: () => `event-${++eventId}`,
    },
  );

  observation.emit(Component.Events.Active, {});
  observation.emit(Component.Events.Failed, { error: "provider unavailable" });
  observation.emit(Component.Events.Disposed, { outcome: "failed" });

  expect(sink.events.map(({ name, data }) => ({ name, data }))).toEqual([
    {
      name: "component.active",
      data: expect.objectContaining({
        eventId: "event-1",
        componentId: "resident.agent",
        componentGeneration: 2,
      }),
    },
    {
      name: "component.failed",
      data: expect.objectContaining({
        eventId: "event-2",
        componentId: "resident.agent",
        error: "provider unavailable",
      }),
    },
    {
      name: "component.disposed",
      data: expect.objectContaining({
        eventId: "event-3",
        componentId: "resident.agent",
        outcome: "failed",
      }),
    },
  ]);
});
