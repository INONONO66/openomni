import { describe, expect, test } from "bun:test";
import { InboundMessage } from "../../src/index.js";

describe("InboundMessage.Input", () => {
  test("parses resident send input with defaults", () => {
    const parsed = InboundMessage.Input.parse({
      target: { kind: "resident", sessionId: "sess-1" },
      action: "send",
      payload: "hello",
    });

    expect(parsed).toEqual({
      target: { kind: "resident", sessionId: "sess-1" },
      action: "send",
      payload: "hello",
      wait: false,
      timeoutMs: 30000,
      injectToHistory: false,
      depth: 0,
    });
  });

  test("parses scheduled worker input", () => {
    const parsed = InboundMessage.Input.parse({
      target: { kind: "worker", parentSessionId: "sess-parent", agentName: "coder" },
      action: "schedule",
      payload: "run nightly review",
      schedule: "0 2 * * *",
      wait: true,
      timeoutMs: 120000,
      injectToHistory: true,
      depth: 2,
    });

    expect(parsed.schedule).toBe("0 2 * * *");
    expect(parsed.wait).toBe(true);
    expect(parsed.timeoutMs).toBe(120000);
    expect(parsed.injectToHistory).toBe(true);
    expect(parsed.depth).toBe(2);
  });

  test("rejects schedule action without schedule expression", () => {
    expect(
      InboundMessage.Input.safeParse({
        target: { kind: "worker" },
        action: "schedule",
        payload: "run later",
      }).success,
    ).toBe(false);
  });

  test("rejects wait timeout when wait is false", () => {
    expect(
      InboundMessage.Input.safeParse({
        target: { kind: "resident" },
        payload: "hello",
        wait: false,
        timeoutMs: 0,
      }).success,
    ).toBe(false);
  });
});

describe("InboundMessage.Result", () => {
  test("parses success result shapes", () => {
    expect(
      InboundMessage.Result.parse({
        status: "sent",
        messageId: "msg-1",
      }),
    ).toEqual({
      status: "sent",
      messageId: "msg-1",
    });

    expect(
      InboundMessage.Result.parse({
        status: "delivered",
        messageId: "msg-2",
        output: "done",
      }),
    ).toEqual({
      status: "delivered",
      messageId: "msg-2",
      output: "done",
    });

    expect(
      InboundMessage.Result.parse({
        status: "scheduled",
        messageId: "msg-3",
      }),
    ).toEqual({
      status: "scheduled",
      messageId: "msg-3",
    });
  });

  test("parses error result shape", () => {
    expect(
      InboundMessage.Result.parse({
        status: "error",
        error: "failed to dispatch",
        timedOut: true,
      }),
    ).toEqual({
      status: "error",
      error: "failed to dispatch",
      timedOut: true,
    });
  });
});

describe("InboundMessage.Events", () => {
  test("parses sent, delivered, and timed out events", () => {
    expect(
      InboundMessage.Events.Sent.schema.parse({
        traceId: "trace-1",
        runId: "run-1",
        sessionId: "sess-1",
        time: 1,
        payload: {
          messageId: "msg-1",
          target: { kind: "resident" },
          action: "send",
        },
      }),
    ).toEqual({
      traceId: "trace-1",
      runId: "run-1",
      sessionId: "sess-1",
      time: 1,
      payload: {
        messageId: "msg-1",
        target: { kind: "resident" },
        action: "send",
      },
    });

    expect(
      InboundMessage.Events.Delivered.schema.parse({
        traceId: "trace-2",
        sessionId: "sess-2",
        time: 2,
        payload: {
          messageId: "msg-2",
          output: "ok",
        },
      }),
    ).toEqual({
      traceId: "trace-2",
      sessionId: "sess-2",
      time: 2,
      payload: {
        messageId: "msg-2",
        output: "ok",
      },
    });

    expect(
      InboundMessage.Events.TimedOut.schema.parse({
        traceId: "trace-3",
        time: 3,
        payload: {
          messageId: "msg-3",
        },
      }),
    ).toEqual({
      traceId: "trace-3",
      time: 3,
      payload: {
        messageId: "msg-3",
      },
    });
  });
});
