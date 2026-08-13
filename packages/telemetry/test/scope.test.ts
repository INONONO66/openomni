import { describe, expect, test } from "bun:test";
import { AgentExecution, BusEvent, Operational } from "@openomni/protocol";
import { z } from "zod";
import {
  collector,
  InvalidTraceScopeError,
  isSpanId,
  requireTraceScope,
  scope,
  type SpanOutcome,
  type SpanPair,
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
    const log = scope(TRACE, sink, { now: clock });

    log.emit(Operational.Info, { component: "test", msg: "hello" });

    expect(sink.named(Operational.Info.name)).toEqual([
      {
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

  /**
   * The type removes the identity fields from every payload, but a caller can
   * always cast past a type. Identity is applied last so the cast loses.
   */
  test("a forged identity in the payload does not win", () => {
    const sink = collector();
    const log = scope(TRACE, sink, { now: clock });

    log.emit(Operational.Info, {
      component: "test",
      msg: "forged",
      traceId: "attacker-trace",
      sessionId: "attacker-session",
    } as never);

    expect(sink.named(Operational.Info.name)[0]).toMatchObject({
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

    child.emit(Operational.Info, { component: "test", msg: "child" });

    expect(sink.named(Operational.Info.name)[0]).toMatchObject({
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

    child.emit(Operational.Info, { component: "test", msg: "child" });

    expect(sink.named(Operational.Info.name)[0]).toMatchObject({ traceId: TRACE_ID });
  });

  /** Narrowing mid-run must not be able to kill the run. */
  test("child keeps the parent value instead of throwing on an absent narrowing", () => {
    const sink = collector();
    const child = scope(TRACE, sink, { now: clock }).child({ runId: undefined, actorId: "a2" });

    child.emit(Operational.Info, { component: "test", msg: "kept" });

    expect(sink.named(Operational.Info.name)[0]).toMatchObject({
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
    child.emit(Operational.Info, { component: "test", msg: "narrowed" });

    expect(sink.named(Operational.Info.name)[0]).toMatchObject({
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

    expect(() => log.emit(Operational.Info, { component: "test", msg: "survive" })).not.toThrow();
    expect(errors).toEqual([Operational.Info.name]);
  });

  /**
   * The reporter is caller-supplied like the sink, so it is the last place the
   * boundary could leak. If it escaped, `emit` would throw and telemetry would
   * be cancelling the work it observes.
   */
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

    expect(() => log.emit(Operational.Info, { component: "test", msg: "survive" })).not.toThrow();
  });
});

const SpanEnd = BusEvent.define(
  "test.span.end",
  z.object({
    traceId: z.string(),
    sessionId: z.string(),
    runId: z.string(),
    time: z.number(),
    kind: z.string(),
    elapsedMs: z.number(),
  }),
);

const TEST_SPAN: SpanPair<
  { readonly label: string },
  { readonly kind: string; readonly elapsedMs: number }
> = {
  start: AgentExecution.TurnStart as never,
  end: SpanEnd as never,
  terminal: (outcome, elapsedMs) => ({ kind: outcome.kind, elapsedMs }),
};

describe("telemetry span", () => {
  async function endKinds(body: (settle: (outcome: SpanOutcome) => void) => Promise<unknown>) {
    const sink = collector();
    const log = scope(TRACE, sink, { now: clock });
    try {
      await log.span(TEST_SPAN, { label: "t" }, (span) => body(span.settle));
    } catch {
      // the throwing case still has to emit its terminal event
    }
    return {
      starts: sink.named(AgentExecution.TurnStart.name).length,
      ends: sink.named(SpanEnd.name) as Array<{ kind: string }>,
    };
  }

  /**
   * The tree an exporter reconstructs. Two mutations — reusing the parent's
   * `spanId`, and dropping `parentSpanId` — each survived the whole suite
   * before this existed, so the package's second headline claim was carried
   * entirely by its documentation.
   */
  test("a span's events carry a fresh child spanId parented to the caller's span", async () => {
    const sink = collector();
    const log = scope(TRACE, sink, { now: clock });

    await log.span(TEST_SPAN, { label: "t" }, async () => "ok");

    const start = sink.named(AgentExecution.TurnStart.name)[0] as {
      spanId: string;
      parentSpanId?: string;
    };
    const end = sink.named(SpanEnd.name)[0] as { spanId: string; parentSpanId?: string };

    expect(isSpanId(start.spanId)).toBe(true);
    expect(start.spanId).not.toBe(SPAN_ID);
    expect(start.parentSpanId).toBe(SPAN_ID);
    // Start and end are the same span, or the pair does not describe one.
    expect(end.spanId).toBe(start.spanId);
    expect(end.parentSpanId).toBe(SPAN_ID);
  });

  test("a normal return ends as completed", async () => {
    const { starts, ends } = await endKinds(async () => "ok");
    expect(starts).toBe(1);
    expect(ends.map((end) => end.kind)).toEqual(["completed"]);
  });

  test("a settled outcome is what the terminal event carries", async () => {
    const { ends } = await endKinds(async (settle) => {
      settle({ kind: "guard_denied", point: "run.turn.pre", policyId: "p", reason: "r" });
      return "returned anyway";
    });
    expect(ends.map((end) => end.kind)).toEqual(["guard_denied"]);
  });

  /**
   * A denial that carries an abort effect settles and then throws. Reporting
   * that as `failed` would lose the point and the reason — exactly what the
   * outcome type exists to keep — so the settled outcome outranks the throw.
   */
  test("a settled outcome survives a throw out of the body", async () => {
    const { ends } = await endKinds(async (settle) => {
      settle({ kind: "guard_denied", point: "tool.pre", policyId: "p", reason: "r" });
      throw new Error("aborted by the denial");
    });
    expect(ends.map((end) => end.kind)).toEqual(["guard_denied"]);
  });

  test("a throw still emits exactly one terminal event", async () => {
    const { starts, ends } = await endKinds(async () => {
      throw new Error("boom");
    });
    expect(starts).toBe(1);
    expect(ends.map((end) => end.kind)).toEqual(["failed"]);
  });

  test("the first settle wins, so an inner guard survives an outer one", async () => {
    const { ends } = await endKinds(async (settle) => {
      settle({ kind: "budget_exhausted", limit: "turns" });
      settle({ kind: "completed" });
      return "done";
    });
    expect(ends.map((end) => end.kind)).toEqual(["budget_exhausted"]);
  });

  test("a sink that throws on the start event does not cancel the body", async () => {
    let bodyRan = false;
    const log = scope(
      TRACE,
      {
        publish() {
          throw new Error("sink exploded");
        },
      },
      { now: clock, onEmitError: () => undefined },
    );

    const result = await log.span(TEST_SPAN, { label: "t" }, async () => {
      bodyRan = true;
      return "done";
    });

    expect(bodyRan).toBe(true);
    expect(result).toBe("done");
  });

  /**
   * `terminal` is caller-supplied. If it threw outside the guard it would
   * escape `span()` and — in the catch branch — replace the error the body
   * actually threw with its own, destroying the only report of what failed.
   */
  test("a throwing terminal builder neither escapes nor replaces the body error", async () => {
    const reported: string[] = [];
    const log = scope(TRACE, collector(), {
      now: clock,
      onEmitError: (_error, name) => reported.push(name),
    });
    const hostile: SpanPair<{ label: string }, { kind: string; elapsedMs: number }> = {
      ...TEST_SPAN,
      terminal: () => {
        throw new Error("terminal exploded");
      },
    };

    await expect(
      log.span(hostile, { label: "t" }, async () => {
        throw new Error("the real error");
      }),
    ).rejects.toThrow("the real error");
    expect(reported).toEqual([SpanEnd.name]);
  });

  test("a throwing reporter does not replace the body error", async () => {
    const log = scope(TRACE, collector(), {
      now: clock,
      onEmitError: () => {
        throw new Error("reporter down");
      },
    });
    const hostile: SpanPair<{ label: string }, { kind: string; elapsedMs: number }> = {
      ...TEST_SPAN,
      terminal: () => {
        throw new Error("terminal exploded");
      },
    };

    await expect(
      log.span(hostile, { label: "t" }, async () => {
        throw new Error("the real failure");
      }),
    ).rejects.toThrow("the real failure");
  });

  test("a throwing body propagates after the terminal event", async () => {
    const sink = collector();
    const log = scope(TRACE, sink, { now: clock });
    await expect(
      log.span(TEST_SPAN, { label: "t" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sink.named(SpanEnd.name)).toHaveLength(1);
  });
});
