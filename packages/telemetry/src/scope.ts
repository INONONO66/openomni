import type { BusEvent } from "@openomni/protocol";
import { createSpanHandle, failedOutcome, type SpanHandle, type SpanPair } from "./span";
import { newSpanId, requireTraceScope, type EmitPayload, type TraceScope } from "./trace";

/**
 * A narrowing of an existing scope. The W3C ids are absent by construction: a
 * child run and a delegated actor belong to the same trace, and span linkage is
 * the emitter's job, not the caller's.
 */
export type ScopeNarrowing = Omit<Partial<TraceScope>, "traceId" | "spanId" | "parentSpanId">;

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
   * Wraps `body` in a child span. The child gets a fresh `spanId` with this
   * scope's span as its parent, so emitted events form a tree an OpenTelemetry
   * exporter can reconstruct without further work.
   *
   * Every exit emits exactly one terminal event: a normal return, a `settle()`
   * recording a policy block or exhausted budget, or a throw.
   */
  span<TStart extends object, TEnd extends object, TResult>(
    pair: SpanPair<TStart, TEnd>,
    start: EmitPayload<TStart>,
    body: (span: SpanHandle, child: Emitter) => Promise<TResult>,
  ): Promise<TResult>;

  /** A narrower scope — a child run or a delegated actor, same trace and span. */
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
 * {@link Emitter.child} and {@link Emitter.span} therefore cannot fail — an
 * absent narrowing keeps the parent's value.
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

  function bind(next: TraceScope): Emitter {
    return scope(next, sink, options);
  }

  async function span<TStart extends object, TEnd extends object, TResult>(
    pair: SpanPair<TStart, TEnd>,
    start: EmitPayload<TStart>,
    body: (handle: SpanHandle, child: Emitter) => Promise<TResult>,
  ): Promise<TResult> {
    const child = bind({ ...identity, spanId: newSpanId(), parentSpanId: identity.spanId });
    const startedAt = now();
    child.emit(pair.start, start);
    const handle = createSpanHandle();
    try {
      const result = await body(handle, child);
      child.emit(
        pair.end,
        pair.terminal(handle.outcome() ?? { kind: "completed" }, now() - startedAt),
      );
      return result;
    } catch (error) {
      child.emit(pair.end, pair.terminal(failedOutcome(error), now() - startedAt));
      throw error;
    }
  }

  return {
    emit,
    span,
    child(narrowing) {
      // Merged, not validated: every field the narrowing omits — or supplies as
      // undefined — keeps the parent's value, so this cannot fail mid-run.
      return bind({ ...identity, ...definedOnly(narrowing) });
    },
    trace: identity,
  };
}

/**
 * The fields a narrowing may carry. An allowlist, not a type-level `Omit`,
 * because a caller can cast past a type: the W3C ids must be unreachable even
 * from `child({ traceId } as never)`. Empty and undefined values are dropped so
 * the parent's value survives.
 */
const NARROWABLE = ["sessionId", "runId", "actorId", "agentName"] as const;

function definedOnly(narrowing: ScopeNarrowing): ScopeNarrowing {
  const kept: Record<string, string> = {};
  for (const field of NARROWABLE) {
    const value = narrowing[field];
    if (typeof value === "string" && value.length > 0) kept[field] = value;
  }
  return kept;
}
