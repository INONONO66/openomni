import type { BusEvent } from "@openomni/protocol";
import { createSpanHandle, failedOutcome, type SpanHandle, type SpanPair } from "./span";
import {
  newSpanId,
  requireTraceScope,
  type EmitPayload,
  type TraceScope,
  type TraceScopeInput,
} from "./trace";

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
   * exporter reconstructs without further work.
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
   * Called when a sink or a payload builder throws. Defaults to a console
   * warning.
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
 * The input is a {@link TraceScopeInput}, not a finished {@link TraceScope}:
 * a root span has no caller to inherit a `spanId` from, so the emitter mints
 * it. Demanding one up front would push that decision onto every caller.
 *
 * Validation happens at construction: a malformed scope is a wiring error the
 * process should not start with, while a throw from inside a run would be
 * telemetry cancelling observed work. {@link Emitter.child} and
 * {@link Emitter.span} derive their identity from an already-valid one, so
 * neither can fail.
 */
export function scope(
  trace: TraceScopeInput,
  sink: BusEvent.Sink,
  options: ScopeOptions = {},
): Emitter {
  const now = options.now ?? Date.now;
  const onEmitError =
    options.onEmitError ??
    ((error, eventName) =>
      console.warn("telemetry emit failed", { eventName, error: String(error) }));
  const identity = Object.freeze(requireTraceScope(trace));

  /**
   * The one place an event reaches the sink. The payload is built inside the
   * guard because a builder can be caller-supplied — a span's `terminal` — and
   * must neither escape nor, in a catch branch, replace the error the body
   * actually threw.
   */
  function publish<TPayload extends object>(
    from: TraceScope,
    descriptor: BusEvent.Descriptor<TPayload>,
    build: () => EmitPayload<TPayload>,
  ): void {
    try {
      // Identity is spread last: a caller who casts past `EmitPayload` still
      // cannot forge a trace id. The cast is the one place TypeScript cannot
      // prove `Omit<T, K> & Pick<T, K>` reconstitutes `T` for a generic `T`.
      const event = { ...build(), time: now(), ...from } as unknown as TPayload;
      sink.publish(descriptor, event);
    } catch (error) {
      report(error, descriptor.name);
    }
  }

  /**
   * The last link in the chain. A caller-supplied reporter is as capable of
   * throwing as the sink it reports on, and letting it through would defeat
   * the guard above by replacing the error the observed code actually threw.
   */
  function report(error: unknown, eventName: string): void {
    try {
      onEmitError(error, eventName);
    } catch {
      // Nothing left to report to.
    }
  }

  async function span<TStart extends object, TEnd extends object, TResult>(
    pair: SpanPair<TStart, TEnd>,
    start: EmitPayload<TStart>,
    body: (handle: SpanHandle, child: Emitter) => Promise<TResult>,
  ): Promise<TResult> {
    const childIdentity: TraceScope = {
      ...identity,
      spanId: newSpanId(),
      parentSpanId: identity.spanId,
    };
    const child = scope(childIdentity, sink, options);
    const startedAt = now();
    publish(childIdentity, pair.start, () => start);
    const handle = createSpanHandle();
    try {
      const result = await body(handle, child);
      publish(childIdentity, pair.end, () =>
        pair.terminal(handle.outcome() ?? { kind: "completed" }, now() - startedAt),
      );
      return result;
    } catch (error) {
      // A settled outcome wins over the throw. A denial that carries an abort
      // effect leaves through this branch, and reporting it as `failed` would
      // lose the reason — the distinction the outcome type exists to keep.
      publish(childIdentity, pair.end, () =>
        pair.terminal(handle.outcome() ?? failedOutcome(error), now() - startedAt),
      );
      throw error;
    }
  }

  return {
    emit(descriptor, payload) {
      publish(identity, descriptor, () => payload);
    },
    span,
    child(narrowing) {
      return scope({ ...identity, ...narrowedFields(narrowing) }, sink, options);
    },
    trace: identity,
  };
}

/**
 * The fields a narrowing may carry. An allowlist, not a type-level `Omit`,
 * because a caller can cast past a type: the W3C ids must be unreachable even
 * from `child({ traceId } as never)`. Reads are guarded because a hostile
 * accessor must not turn narrowing a scope into a way to stop a run.
 */
const NARROWABLE = ["sessionId", "runId", "actorId", "agentName"] as const;

function narrowedFields(narrowing: ScopeNarrowing): ScopeNarrowing {
  const kept: Record<string, string> = {};
  for (const field of NARROWABLE) {
    try {
      const value = narrowing[field];
      if (typeof value === "string" && value.length > 0) kept[field] = value;
    } catch {
      // A throwing accessor drops its own field; the parent's value survives.
    }
  }
  return kept;
}
