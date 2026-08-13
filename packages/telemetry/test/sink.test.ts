import { describe, expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { collector, noopSink, scope, tee, type TraceScope } from "@openomni/telemetry";

const TRACE: TraceScope = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  sessionId: "s",
  runId: "r",
};

describe("telemetry sinks", () => {
  test("tee fans out to every sink", () => {
    const left = collector();
    const right = collector();
    const log = scope(TRACE, tee([left, right]));

    log.emit(Operational.Info, { component: "test", msg: "both" });

    expect(left.events).toHaveLength(1);
    expect(right.events).toHaveLength(1);
  });

  /**
   * The package's boundary test: observation never changes what the observed
   * code does. A downstream sink that throws must not reach the emitter, and
   * must not stop its siblings.
   */
  test("a throwing sink neither escapes nor suppresses its siblings", () => {
    const errors: Array<{ eventName: string }> = [];
    const survivor = collector();
    const hostile = {
      publish() {
        throw new Error("sink exploded");
      },
    };
    const log = scope(
      TRACE,
      tee([hostile, survivor], { onSinkError: (_error, eventName) => errors.push({ eventName }) }),
    );

    expect(() => log.emit(Operational.Info, { component: "test", msg: "survive" })).not.toThrow();
    expect(survivor.events).toHaveLength(1);
    expect(errors).toEqual([{ eventName: Operational.Info.name }]);
  });

  test("noopSink discards without throwing", () => {
    const log = scope(TRACE, noopSink());
    expect(() => log.emit(Operational.Info, { component: "test", msg: "gone" })).not.toThrow();
  });

  test("collector filters by descriptor name and resets", () => {
    const sink = collector();
    const log = scope(TRACE, sink);

    log.emit(Operational.Info, { component: "a", msg: "one" });
    log.emit(Operational.Warn, { component: "b", msg: "two" });

    expect(sink.named(Operational.Info.name)).toHaveLength(1);
    expect(sink.named(Operational.Warn.name)).toHaveLength(1);

    sink.reset();
    expect(sink.events).toHaveLength(0);
  });
});
