import { describe, expect, spyOn, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import {
  collector,
  InvalidTraceScopeError,
  requireTraceScope,
  scope,
  type TraceScope,
} from "@openomni/telemetry";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

const TRACE: TraceScope = {
  traceId: TRACE_ID,
  spanId: SPAN_ID,
  sessionId: "session-1",
  runId: "run-1",
  actorId: "actor-1",
};

const clock = () => 1_700_000_000_000;

describe("telemetry scope", () => {
  test("supplies identity and time so a payload cannot carry them", () => {
    const sink = collector();
    const log = scope(TRACE, sink, { now: clock, newEventId: () => "event-1" });

    log.emit(Operational.Events.Info, { component: "test", msg: "hello" });

    expect(sink.named(Operational.Events.Info.name)).toEqual([
      {
        eventId: "event-1",
        time: clock(),
        component: "test",
        msg: "hello",
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        sessionId: "session-1",
        runId: "run-1",
        actorId: "actor-1",
      },
    ]);
  });

  test("exposes a normalized sink with event and component identity", () => {
    const sink = collector();
    const log = scope(
      {
        ...TRACE,
        componentId: "resident.agent",
        componentGeneration: 3,
        pluginName: "builtin.resident",
        pluginVersion: "1.0.0",
        configRevision: 7,
      },
      sink,
      { now: clock, newEventId: () => "event-1" },
    );

    log.sink.publish(
      Operational.Events.Info,
      {
        traceId: "forged",
        time: 1,
        component: "agent",
        msg: "started",
      } as never,
    );

    expect(sink.named(Operational.Events.Info.name)).toEqual([
      {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        sessionId: "session-1",
        runId: "run-1",
        actorId: "actor-1",
        componentId: "resident.agent",
        componentGeneration: 3,
        pluginName: "builtin.resident",
        pluginVersion: "1.0.0",
        configRevision: 7,
        eventId: "event-1",
        time: 1_700_000_000_000,
        component: "agent",
        msg: "started",
      },
    ]);
  });

  /**
   * The type removes the identity fields from every payload, but a caller can
   * always cast past a type. Identity is applied last so the cast loses.
   */
  test("a forged identity in the payload does not win", () => {
    const sink = collector();
    const log = scope(TRACE, sink, { now: clock });

    log.emit(Operational.Events.Info, {
      component: "test",
      msg: "forged",
      traceId: "attacker-trace",
      sessionId: "attacker-session",
    } as never);

    expect(sink.named(Operational.Events.Info.name)[0]).toMatchObject({
      traceId: TRACE_ID,
      sessionId: "session-1",
    });
  });

  test("the emitter's identity is frozen", () => {
    const log = scope(TRACE, collector(), { now: clock });
    expect(Object.isFrozen(log.trace)).toBe(true);
  });

  test("child narrows the scope and keeps the rest", () => {
    const sink = collector();
    const child = scope(TRACE, sink, { now: clock }).child({ runId: "run-2" });

    child.emit(Operational.Events.Info, { component: "test", msg: "child" });

    expect(sink.named(Operational.Events.Info.name)[0]).toMatchObject({
      traceId: TRACE_ID,
      sessionId: "session-1",
      runId: "run-2",
    });
  });

  test("refuses an incomplete scope rather than emitting an uncorrelatable record", () => {
    expect(() => requireTraceScope({ traceId: TRACE_ID })).toThrow(InvalidTraceScopeError);
    expect(() => requireTraceScope({ traceId: "not-hex", sessionId: "s", runId: "r" })).toThrow(
      InvalidTraceScopeError,
    );
    expect(requireTraceScope({ traceId: TRACE_ID, sessionId: "s", runId: "r" })).toMatchObject({
      traceId: TRACE_ID,
      sessionId: "s",
      runId: "r",
    });
  });

  /** Construction is the composition root, so refusing there is a wiring error. */
  test("scope validates at construction", () => {
    expect(() =>
      scope({ traceId: "", spanId: SPAN_ID, sessionId: "s", runId: "r" }, collector()),
    ).toThrow(InvalidTraceScopeError);
  });

  /**
   * A child belongs to the same trace. If it could mint a new `traceId`, the
   * thirteen `crypto.randomUUID()` sites this package exists to replace would
   * be one call away from being re-expressible through the emitter itself.
   */
  test("child cannot replace the trace id", () => {
    const sink = collector();
    const child = scope(TRACE, sink, { now: clock }).child({
      traceId: "attacker-trace",
    } as never);

    child.emit(Operational.Events.Info, { component: "test", msg: "child" });

    expect(sink.named(Operational.Events.Info.name)[0]).toMatchObject({ traceId: TRACE_ID });
  });

  /** Narrowing mid-run must not be able to kill the run. */
  test("child keeps the parent value instead of throwing on an absent narrowing", () => {
    const sink = collector();
    const child = scope(TRACE, sink, { now: clock }).child({ runId: undefined, actorId: "a2" });

    child.emit(Operational.Events.Info, { component: "test", msg: "kept" });

    expect(sink.named(Operational.Events.Info.name)[0]).toMatchObject({
      runId: "run-1",
      actorId: "a2",
    });
  });

  /** Narrowing a scope must not be a way to stop a run. */
  test("a throwing accessor on a narrowing drops only its own field", () => {
    const sink = collector();
    const narrowing = { actorId: "kept" };
    Object.defineProperty(narrowing, "runId", {
      enumerable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });

    const child = scope(TRACE, sink, { now: clock }).child(narrowing);
    child.emit(Operational.Events.Info, { component: "test", msg: "narrowed" });

    expect(sink.named(Operational.Events.Info.name)[0]).toMatchObject({
      runId: "run-1",
      actorId: "kept",
    });
  });

  /**
   * The package's boundary rule: replacing telemetry with no-ops must leave
   * observed behavior identical, and a no-op cannot throw.
   */
  test("a throwing sink never reaches the caller", () => {
    const errors: string[] = [];
    const log = scope(
      TRACE,
      {
        publish() {
          throw new Error("sink exploded");
        },
      },
      { now: clock, onEmitError: (_error, name) => errors.push(name) },
    );

    expect(() =>
      log.emit(Operational.Events.Info, { component: "test", msg: "survive" }),
    ).not.toThrow();
    expect(errors).toEqual([Operational.Events.Info.name]);
  });

  /**
   * The reporter is caller-supplied like the sink, so it is the last place the
   * boundary could leak. If it escaped, `emit` would throw and telemetry would
   * be cancelling the work it observes.
   */
  test("the default error reporter contains a throwing sink", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const log = scope(TRACE, {
        publish() {
          throw new Error("sink exploded");
        },
      });

      expect(() =>
        log.emit(Operational.Events.Info, { component: "test", msg: "survive" }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a throwing error reporter does not escape emit", () => {
    const log = scope(
      TRACE,
      {
        publish() {
          throw new Error("sink exploded");
        },
      },
      {
        now: clock,
        onEmitError: () => {
          throw new Error("reporter down");
        },
      },
    );

    expect(() =>
      log.emit(Operational.Events.Info, { component: "test", msg: "survive" }),
    ).not.toThrow();
  });
});
