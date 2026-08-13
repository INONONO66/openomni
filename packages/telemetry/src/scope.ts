import type { BusEvent } from "@openomni/protocol";
import { createSpanHandle, failedOutcome, type SpanHandle, type SpanPair } from "./span";
import { requireTraceScope, type EmitPayload, type TraceScope } from "./trace";

/**
 * A narrowing of an existing scope. `traceId` is absent by construction: a
 * child run, a delegated actor, and a nested span all belong to the same trace,
 * and minting a new one here is how correlation gets lost.
 */
export type ScopeNarrowing = Omit<Partial<TraceScope>, "traceId">;

export interface Emitter {
  /**
   * Publishes one event. The scope's identity and the timestamp are supplied
   * here, not by the caller — {@link EmitPayload} removes them from the payload
   * type, and they are applied last so a cast cannot override them.
   *
   * Never throws. A sink that fails is reported through `onEmitError` and the
   * caller continues: observation does not get to change what the observed
   * code does.
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

  /** A narrower scope — a child run or a delegated actor, same trace. */
  child(narrowing: ScopeNarrowing): Emitter;

  readonly trace: TraceScope;
}

export interface ScopeOptions {
  /** Injectable clock. Tests pin it; production leaves it alone. */
  readonly now?: () => number;
  /**
   * Called when a sink throws. Defaults to a console warning.
   *
   * The failure is reported, never raised. This is the package's boundary
   * test: replacing telemetry wholesale with no-ops must leave observed
   * behavior identical, and a no-op cannot throw.
   */
  readonly onEmitError?: (error: unknown, eventName: string) => void;
}

/**
 * Builds an emitter bound to one trace identity.
 *
 * Validation happens here, at the composition root, and nowhere else: a
 * malformed scope is a wiring error the process should not start with, while a
 * throw from inside a run would be telemetry cancelling observed work.
 * {@link Emitter.child} therefore cannot fail — an absent narrowing keeps the
 * parent's value.
 */
export function scope(trace: TraceScope, sink: BusEvent.Sink, options: ScopeOptions = {}): Emitter {
  const now = options.now ?? Date.now;
  const onEmitError =
    options.onEmitError ??
    ((error, eventName) =>
      console.warn("telemetry emit failed", { eventName, error: String(error) }));
  const identity = Object.freeze(requireTraceScope(trace));

  function emit<TPayload extends object>(
    descriptor: BusEvent.Descriptor<TPayload>,
    payload: EmitPayload<TPayload>,
  ): void {
    try {
      // Identity is spread last: a caller who casts past `EmitPayload` still
      // cannot forge a trace id. The cast below is the one place TypeScript
      // cannot prove `Omit<T, K> & Pick<T, K>` reconstitutes `T` for generic `T`.
      const event = { time: now(), ...payload, ...identity } as unknown as TPayload;
      sink.publish(descriptor, event);
    } catch (error) {
      onEmitError(error, descriptor.name);
    }
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
    child(narrowing) {
      // Merged, not validated: every field the narrowing omits — or supplies as
      // undefined — keeps the parent's value, so this cannot fail mid-run.
      return scope(
        { ...identity, ...definedOnly(narrowing), traceId: identity.traceId },
        sink,
        options,
      );
    },
    trace: identity,
  };
}

function definedOnly(narrowing: ScopeNarrowing): ScopeNarrowing {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(narrowing)) {
    if (typeof value === "string" && value.length > 0) kept[key] = value;
  }
  return kept;
}
