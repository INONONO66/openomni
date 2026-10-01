import { describe, expect, it } from "bun:test";
import { Effect, Logger } from "effect";
import { newTraceId, scopeObservation } from "../../src/index";
import { collector } from "../helpers/observation-collector";
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

  it("preserves strict descriptor payload fields while stamping scope identity", () => {
    const StrictEvent = BusEvent.define(
      "test.scope.strict",
      z.object({ component: z.string(), msg: z.string() }).strict(),
    );
    const received: Array<z.infer<typeof StrictEvent> & { extra: string }> = [];
    const scoped = scopeObservation({
      publish: (_event, data) => received.push(z.object({
        component: z.string(),
        msg: z.string(),
        extra: z.string(),
      }).parse(data)),
      scope: () => scoped,
    }, identity, { clock: () => 42, entropy: () => "event-strict" });
    scoped.publish(StrictEvent, { component: "test", msg: "strict", extra: "kept" } as never);
    expect(received[0]).toMatchObject({ component: "test", msg: "strict", extra: "kept" });
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
    expect(() => scoped.publish(TestEvent, { component: "test", msg: "valid" })).not.toThrow();

    expect(errors).toEqual([
      { name: TestEvent.name, type: "TypeError" },
      { name: TestEvent.name, type: "TypeError" },
      { name: TestEvent.name, type: "Error" },
    ]);
  });

  it.each([
    new Error("reporter failed"), Symbol("reporter"), { toString: 0 }, null, undefined,
    false, 1, 1n, "reporter", () => undefined,
  ])("contains reporter failure without changing its identity: %p", (reporterFailure) => {
    const hostile: ObservationSink = {
      publish() {
        throw new Error("sink failed");
      },
      scope() {
        return hostile;
      },
    };
    const entries: { level: string; parts: unknown[] }[] = [];
    const collector = Logger.make((options) => {
      entries.push({
        level: options.logLevel,
        parts: Array.isArray(options.message) ? [...options.message] : [options.message],
      });
    });
    const capture = <A>(body: () => A): A =>
      Effect.runSync(Effect.sync(body).pipe(Effect.provide(Logger.layer([collector]))));

    capture(() =>
      scopeObservation(hostile, identity).publish(TestEvent, {
        component: "test",
        msg: "default reporter",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "Warn" });
    expect(entries[0]?.parts.map(String).join(" ")).toContain("observation emit failed");
    entries.length = 0;

    const scoped = scopeObservation(hostile, identity, {
      onError() {
        throw reporterFailure;
      },
    });
    expect(() =>
      capture(() => scoped.publish(TestEvent, { component: "test", msg: "custom reporter" })),
    ).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "Error" });
    const detail = entries[0]?.parts.find((part) => typeof part === "object" && part !== null);
    expect(detail).toMatchObject({
      eventName: TestEvent.name,
      error: { errors: [expect.objectContaining({ message: "sink failed" }), reporterFailure] },
    });
    const logged = z.object({ error: z.instanceof(AggregateError) }).parse(detail);
    expect(logged.error.errors[1]).toBe(reporterFailure);
  });

  it("forwards subscriptions when the underlying sink supports them", () => {
    let subscribed = false;
    const sink: ObservationSink = {
      publish: () => undefined,
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

  it("generates compact trace identifiers", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
