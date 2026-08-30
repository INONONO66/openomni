import type { BusEvent } from "@openomni/protocol";
import {
  requireTraceScope,
  type EmitPayload,
  type SpanId,
  type TraceScope,
} from "./trace";

/**
 * A narrowing of an existing scope. The W3C ids are absent by construction: a
 * child run and a delegated actor belong to the same trace, and span linkage is
 * the emitter's job, not the caller's.
 */
type ScopeNarrowing = Omit<Partial<TraceScope>, "traceId" | "spanId" | "parentSpanId">;

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

  /** A narrower scope — a child run or a delegated actor, same trace and span. */
  child(narrowing: ScopeNarrowing): Emitter;

  /** Compatibility port for packages that accept the protocol's raw sink. */
  readonly sink: BusEvent.Sink;

  readonly trace: TraceScope;
}

export interface ScopeOptions {
  /** Injectable clock. Tests pin it; production leaves it alone. */
  readonly now?: () => number;
  /** Injectable event-id mint. Tests pin it; production leaves it alone. */
  readonly newEventId?: () => string;
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
 * Only `spanId` is optional: a root span has no caller to inherit one from,
 * so the emitter mints it. The rest stay required in the type — a scope that
 * cannot name its trace, session, or run is a compile error here, not a
 * runtime throw somewhere further in.
 *
 * Validation happens at construction: a malformed scope is a wiring error the
 * process should not start with, while a throw from inside a run would be
 * telemetry cancelling observed work. {@link Emitter.child} and
 * {@link Emitter.child} derives its identity from an already-valid one, so it
 * cannot fail.
 */
export function scope(
  trace: Omit<TraceScope, "spanId"> & { readonly spanId?: SpanId },
  sink: BusEvent.Sink,
  options: ScopeOptions = {},
): Emitter {
  const now = options.now ?? Date.now;
  const newEventId = options.newEventId ?? (() => crypto.randomUUID());
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
      const event = {
        ...build(),
        eventId: newEventId(),
        time: now(),
        ...from,
      } as unknown as TPayload;
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

  const scopedSink: BusEvent.Sink = {
    publish(descriptor, data) {
      publish(identity, descriptor as BusEvent.Descriptor<object>, () => {
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          throw new TypeError("scoped telemetry payload must be an object");
        }
        return data;
      });
    },
  };

  return {
    emit(descriptor, payload) {
      publish(identity, descriptor, () => payload);
    },
    child(narrowing) {
      return scope({ ...identity, ...narrowedFields(narrowing) }, sink, options);
    },
    sink: scopedSink,
    trace: identity,
  };
}

/**
 * The fields a narrowing may carry. An allowlist, not a type-level `Omit`,
 * because a caller can cast past a type: the W3C ids must be unreachable even
 * from `child({ traceId } as never)`. Reads are guarded because a hostile
 * accessor must not turn narrowing a scope into a way to stop a run.
 */
const NARROWABLE = [
  "sessionId",
  "runId",
  "actorId",
  "agentName",
  "componentId",
  "componentGeneration",
  "pluginName",
  "pluginVersion",
  "configRevision",
] as const;

function narrowedFields(narrowing: ScopeNarrowing): ScopeNarrowing {
  const kept: Record<string, string | number> = {};
  for (const field of NARROWABLE) {
    try {
      const value = narrowing[field];
      if (
        (typeof value === "string" && value.length > 0) ||
        (typeof value === "number" && Number.isInteger(value) && value >= 0)
      ) {
        kept[field] = value;
      }
    } catch {
      // A throwing accessor drops its own field; the parent's value survives.
    }
  }
  return kept as ScopeNarrowing;
}
