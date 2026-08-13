import type { BusEvent } from "@openomni/protocol";
import { createSpanHandle, failedOutcome, type SpanHandle, type SpanPair } from "./span";
import { requireTraceScope, type EmitPayload, type TraceScope } from "./trace";

export interface Emitter {
  /**
   * Publishes one event. The scope's identity and the timestamp are supplied
   * here, not by the caller — {@link EmitPayload} removes them from the
   * payload type, and they are applied last so a cast cannot override them.
   */
  emit<TPayload extends object>(
    descriptor: BusEvent.Descriptor<TPayload>,
    payload: EmitPayload<TPayload>,
  ): void;

  /**
   * Wraps `body` so its start and end events are always paired. Every exit
   * emits exactly one terminal event: a normal return, a `settle()` recording
   * a policy block or exhausted budget, or a throw.
   */
  span<TStart extends object, TEnd extends object, TResult>(
    pair: SpanPair<TStart, TEnd>,
    start: EmitPayload<TStart>,
    body: (span: SpanHandle) => Promise<TResult>,
  ): Promise<TResult>;

  /** A narrower scope — a child run or a delegated actor. */
  child(overrides: Partial<TraceScope>): Emitter;

  readonly trace: TraceScope;
  readonly sink: BusEvent.Sink;
}

export interface ScopeOptions {
  /** Injectable clock. Tests pin it; production leaves it alone. */
  readonly now?: () => number;
}

export function scope(trace: TraceScope, sink: BusEvent.Sink, options: ScopeOptions = {}): Emitter {
  const now = options.now ?? Date.now;
  const identity = Object.freeze({ ...trace });

  function emit<TPayload extends object>(
    descriptor: BusEvent.Descriptor<TPayload>,
    payload: EmitPayload<TPayload>,
  ): void {
    // Identity is spread last: a caller who casts past `EmitPayload` still
    // cannot forge a trace id. The cast below is the one place TypeScript
    // cannot prove `Omit<T, K> & Pick<T, K>` reconstitutes `T` for generic `T`.
    const event = { time: now(), ...payload, ...identity } as unknown as TPayload;
    sink.publish(descriptor, event);
  }

  async function span<TStart extends object, TEnd extends object, TResult>(
    pair: SpanPair<TStart, TEnd>,
    start: EmitPayload<TStart>,
    body: (handle: SpanHandle) => Promise<TResult>,
  ): Promise<TResult> {
    const startedAt = now();
    emit(pair.start, start);
    const handle = createSpanHandle();
    try {
      const result = await body(handle);
      emit(pair.end, pair.terminal(handle.outcome() ?? { kind: "completed" }, now() - startedAt));
      return result;
    } catch (error) {
      emit(pair.end, pair.terminal(failedOutcome(error), now() - startedAt));
      throw error;
    }
  }

  return {
    emit,
    span,
    child(overrides) {
      return scope(requireTraceScope({ ...identity, ...overrides }), sink, options);
    },
    trace: identity,
    sink,
  };
}
