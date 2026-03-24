import { afterEach, describe, expect, it } from "bun:test";
import { EventLog } from "../../src/event-log/index";

const now = new Date().toISOString();

function makeEvent(type: string, sequence: number) {
  if (type === "llm_response") {
    return {
      type: "llm_response" as const,
      turnIndex: 0,
      text: "hello",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      timestamp: now,
      sequence,
    };
  }
  return {
    type: "session_suspended" as const,
    reason: "test",
    timestamp: now,
    sequence,
  };
}

afterEach(() => {
  EventLog._reset();
});

describe("EventLog", () => {
  it("appends and replays events in order", async () => {
    await EventLog.append("sess-1", makeEvent("llm_response", 1));
    await EventLog.append("sess-1", makeEvent("session_suspended", 2));
    await EventLog.append("sess-1", makeEvent("llm_response", 3));

    const events = [];
    for await (const event of EventLog.replay("sess-1")) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
    expect(events[2].sequence).toBe(3);
  });

  it("replays empty for unknown session", async () => {
    const events = [];
    for await (const event of EventLog.replay("unknown")) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });

  it("listIncomplete returns sessions without markComplete", async () => {
    await EventLog.append("sess-1", makeEvent("llm_response", 1));
    await EventLog.append("sess-2", makeEvent("llm_response", 1));
    await EventLog.append("sess-3", makeEvent("llm_response", 1));
    await EventLog.markComplete("sess-2");

    const incomplete = await EventLog.listIncomplete();
    expect(incomplete).toContain("sess-1");
    expect(incomplete).toContain("sess-3");
    expect(incomplete).not.toContain("sess-2");
  });

  it("markComplete removes session from incomplete list", async () => {
    await EventLog.append("sess-1", makeEvent("llm_response", 1));
    await EventLog.markComplete("sess-1");

    const incomplete = await EventLog.listIncomplete();
    expect(incomplete).not.toContain("sess-1");
  });

  it("appends to multiple sessions independently", async () => {
    await EventLog.append("sess-a", makeEvent("llm_response", 1));
    await EventLog.append("sess-b", makeEvent("session_suspended", 1));

    const eventsA = [];
    for await (const e of EventLog.replay("sess-a")) eventsA.push(e);
    const eventsB = [];
    for await (const e of EventLog.replay("sess-b")) eventsB.push(e);

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].type).toBe("llm_response");
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].type).toBe("session_suspended");
  });
});
