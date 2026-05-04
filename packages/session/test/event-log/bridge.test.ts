import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { BusEvent, ToolExecution, type ExecutionEvent } from "@openomni/protocol";
import { Bus } from "../../src/bus/index.js";
import { EventLog } from "../../src/event-log/index.js";
import { EventLogBridge } from "../../src/event-log/bridge.js";
import { Session } from "../../src/session/index.js";
import { Storage } from "../../src/storage/storage.js";
import "../../src/storage/initialize.js";

async function flushBridge(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function replay(sessionId: string): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of EventLog.replay(sessionId)) {
    events.push(event);
  }
  return events;
}

async function waitForReplay(sessionId: string, expectedCount: number): Promise<ExecutionEvent[]> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const events = await replay(sessionId);
    if (events.length >= expectedCount) return events;
    await flushBridge();
  }
  return replay(sessionId);
}

describe("EventLogBridge", () => {
  let stopBridge: (() => void) | undefined;

  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    stopBridge?.();
    stopBridge = undefined;
    Bus.reset();
    Storage.reset();
  });

  test("mirrors known BusEvents into matching ExecutionEvent variants", async () => {
    const session = Session.create({
      title: "bridge known",
      model: { providerID: "test", modelID: "test-model" },
    });
    const time = Date.UTC(2026, 4, 4, 12, 0, 0);

    stopBridge = EventLogBridge.start();
    Bus.publish(ToolExecution.Started, {
      traceId: "trace-1",
      sessionId: session.id,
      actor: { agentName: "researcher" },
      toolCallId: "call-1",
      toolName: "search",
      inputSummary: '{"query":"openomni"}',
      time,
    });

    const events = await waitForReplay(session.id, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_started",
      actionId: `${session.id}:tool.execution.started:1`,
      visibility: "internal",
      timestamp: new Date(time).toISOString(),
      sequence: 1,
      toolCallId: "call-1",
      toolName: "search",
      args: {
        actor: { agentName: "researcher" },
        inputSummary: '{"query":"openomni"}',
      },
    });
  });

  test("mirrors permission denied actor context", async () => {
    const session = Session.create({
      title: "bridge denied",
      model: { providerID: "test", modelID: "test-model" },
    });

    stopBridge = EventLogBridge.start();
    Bus.publish(ToolExecution.PermissionDenied, {
      traceId: "trace-denied",
      sessionId: session.id,
      actor: { agentName: "reviewer" },
      toolCallId: "call-denied",
      toolName: "bash",
      reason: "denied by policy",
      time: Date.UTC(2026, 4, 4, 12, 1, 0),
    });

    const events = await waitForReplay(session.id, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "action_blocked",
      policyId: "tool.execution.permission_denied",
      actor: { agentName: "reviewer" },
      action: "tool.call",
      resource: "bash",
      verdict: "abort",
      reason: "denied by policy",
    });
  });

  test("mirrors unknown non-ephemeral BusEvents as generic durable bus_event entries", async () => {
    const session = Session.create({
      title: "bridge unknown",
      model: { providerID: "test", modelID: "test-model" },
    });
    const event = BusEvent.define(
      "custom.event",
      z.object({ sessionId: z.string(), label: z.string() }),
      { visibility: "user_audit" },
    );

    stopBridge = EventLogBridge.start();
    Bus.publish(event, { sessionId: session.id, label: "mirrored" });

    const events = await waitForReplay(session.id, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "bus_event",
      name: "custom.event",
      payload: { sessionId: session.id, label: "mirrored" },
      actionId: `${session.id}:custom.event:1`,
      visibility: "user_audit",
      timestamp: expect.any(String),
      sequence: 1,
    });
  });

  test("does not mirror ephemeral BusEvents", async () => {
    const session = Session.create({
      title: "bridge ephemeral",
      model: { providerID: "test", modelID: "test-model" },
    });
    const event = BusEvent.define(
      "custom.ephemeral",
      z.object({ sessionId: z.string(), label: z.string() }),
      { visibility: "ephemeral" },
    );

    stopBridge = EventLogBridge.start();
    Bus.publish(event, { sessionId: session.id, label: "skip" });
    await flushBridge();

    expect(await replay(session.id)).toEqual([]);
  });
});
