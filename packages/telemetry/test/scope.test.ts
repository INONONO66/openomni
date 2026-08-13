import { describe, expect, test } from "bun:test";
import { AgentExecution, BusEvent, Operational } from "@openomni/protocol";
import { z } from "zod";
import {
  collector,
  MissingTraceScopeError,
  requireTraceScope,
  scope,
  type SpanPair,
  type TraceScope,
} from "@openomni/telemetry";

const TRACE: TraceScope = {
  traceId: "trace-1",
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
        traceId: "trace-1",
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
      traceId: "trace-1",
      sessionId: "session-1",
    });
  });

  test("child narrows the scope and keeps the rest", () => {
    const sink = collector();
    const child = scope(TRACE, sink, { now: clock }).child({ runId: "run-2" });

    child.emit(Operational.Info, { component: "test", msg: "child" });

    expect(sink.named(Operational.Info.name)[0]).toMatchObject({
      traceId: "trace-1",
      sessionId: "session-1",
      runId: "run-2",
    });
  });

  test("refuses an incomplete scope rather than emitting an uncorrelatable record", () => {
    expect(() => requireTraceScope({ traceId: "t" })).toThrow(MissingTraceScopeError);
    expect(() => requireTraceScope({ traceId: "t", sessionId: "", runId: "r" })).toThrow(
      MissingTraceScopeError,
    );
    expect(requireTraceScope({ traceId: "t", sessionId: "s", runId: "r" })).toEqual({
      traceId: "t",
      sessionId: "s",
      runId: "r",
    });
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
  async function endKinds(body: (settle: (outcome: never) => void) => Promise<unknown>) {
    const sink = collector();
    const log = scope(TRACE, sink, { now: clock });
    try {
      await log.span(TEST_SPAN, { label: "t" }, (span) =>
        body(span.settle as (outcome: never) => void),
      );
    } catch {
      // the throwing case still has to emit its terminal event
    }
    return {
      starts: sink.named(AgentExecution.TurnStart.name).length,
      ends: sink.named(SpanEnd.name) as Array<{ kind: string }>,
    };
  }

  test("a normal return ends as completed", async () => {
    const { starts, ends } = await endKinds(async () => "ok");
    expect(starts).toBe(1);
    expect(ends.map((end) => end.kind)).toEqual(["completed"]);
  });

  test("a settled outcome is what the terminal event carries", async () => {
    const { ends } = await endKinds(async (settle) => {
      settle({ kind: "guard_denied", point: "run.turn.pre", policyId: "p", reason: "r" } as never);
      return "returned anyway";
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
      settle({ kind: "budget_exhausted", limit: "turns" } as never);
      settle({ kind: "completed" } as never);
      return "done";
    });
    expect(ends.map((end) => end.kind)).toEqual(["budget_exhausted"]);
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
