import { describe, expect, it, mock } from "bun:test";
import { collector, newTraceId, noopSink, scopeObservation } from "../../src/index";
import { BusEvent, type ObservationSink } from "@openomni/protocol";
import { z } from "zod";

const TestEvent = BusEvent.define(
  "test.scope",
  z.object({ component: z.string(), msg: z.string() }).passthrough(),
);

const identity = {
  traceId: "trace-1",
  sessionId: "session-1",
  runId: "run-1",
  actorId: "actor-1",
};

describe("scoped observations", () => {
  it("stamps authoritative identity, event id, and time onto payloads", () => {
    const sink = collector();
    const scoped = scopeObservation(sink, identity, {
      clock: () => 42,
      entropy: () => "event-1",
    });

    scoped.publish(TestEvent, {
      traceId: "forged",
      time: 1,
      component: "test",
      msg: "observed",
    });

    expect(sink.named(TestEvent.name)).toEqual([
      {
        traceId: "trace-1",
        sessionId: "session-1",
        runId: "run-1",
        actorId: "actor-1",
        eventId: "event-1",
        time: 42,
        component: "test",
        msg: "observed",
      },
    ]);
  });

  it("merges child identity while retaining parent fields", () => {
    const sink = collector();
    const parent = scopeObservation(sink, identity, {
      clock: () => 42,
      entropy: () => "event-2",
    });
    const child = parent.scope?.({ runId: "run-2" });
    if (child === undefined) throw new Error("scoped sink must support child scopes");

    child.publish(TestEvent, { component: "test", msg: "child" });

    expect(sink.events[0]?.data).toMatchObject({
      traceId: "trace-1",
      sessionId: "session-1",
      runId: "run-2",
      actorId: "actor-1",
    });
  });

  it("reports invalid payloads and sink failures without escaping", () => {
    const errors: Array<{ name: string; type: string }> = [];
    const hostile: ObservationSink = {
      publish() {
        throw new Error("sink failed");
      },
      scope() {
        return hostile;
      },
    };
    const scoped = scopeObservation(hostile, identity, {
      onError: (error, name) => errors.push({ name, type: error.name }),
    });

    expect(() => Reflect.apply(scoped.publish, scoped, [TestEvent, null])).not.toThrow();
    expect(() => Reflect.apply(scoped.publish, scoped, [TestEvent, []])).not.toThrow();
    expect(() =>
      scoped.publish(TestEvent, { component: "test", msg: "valid" }),
    ).not.toThrow();

    expect(errors).toEqual([
      { name: TestEvent.name, type: "TypeError" },
      { name: TestEvent.name, type: "TypeError" },
      { name: TestEvent.name, type: "Error" },
    ]);
  });

  it("contains failures from the default and caller-provided error reporters", () => {
    const warn = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warn;
    const hostile: ObservationSink = {
      publish() {
        throw "sink failed";
      },
      scope() {
        return hostile;
      },
    };
    try {
      scopeObservation(hostile, identity).publish(TestEvent, {
        component: "test",
        msg: "default reporter",
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }

    const scoped = scopeObservation(hostile, identity, {
      onError() {
        throw new Error("reporter failed");
      },
    });
    expect(() =>
      scoped.publish(TestEvent, { component: "test", msg: "custom reporter" }),
    ).not.toThrow();
  });

  it("forwards subscriptions when the underlying sink supports them", () => {
    let subscribed = false;
    const sink: ObservationSink = {
      publish() {},
      scope() {
        return sink;
      },
      subscribe() {
        subscribed = true;
        return () => {
          subscribed = false;
        };
      },
    };
    const scoped = scopeObservation(sink, identity);

    const unsubscribe = scoped.subscribe?.(TestEvent, () => undefined);
    expect(subscribed).toBe(true);
    unsubscribe?.();
    expect(subscribed).toBe(false);
  });

  it("collector groups and resets observations", () => {
    const sink = collector();
    const OtherEvent = BusEvent.define("test.scope.other", z.object({ value: z.number() }));
    sink.publish(TestEvent, { component: "a", msg: "one" });
    sink.publish(OtherEvent, { value: 2 });

    expect(sink.named(TestEvent.name)).toHaveLength(1);
    expect(sink.named(OtherEvent.name)).toHaveLength(1);
    sink.reset();
    expect(sink.events).toEqual([]);
  });

  it("noop sink and its scopes discard observations", () => {
    const sink = noopSink();
    expect(() =>
      sink.publish(TestEvent, { component: "test", msg: "discard" }),
    ).not.toThrow();
    expect(() =>
      sink
        .scope?.(identity)
        .publish(TestEvent, { component: "test", msg: "discard" }),
    ).not.toThrow();
  });

  it("generates compact trace identifiers", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
