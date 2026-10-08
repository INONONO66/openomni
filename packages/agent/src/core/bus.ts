import { BusEvent, type ObservationSink, Gateway, type Inbox, type SessionTurn } from "@openomni/protocol";
import { Data, Effect, FiberSet, Layer, PubSub, type Scope, Stream } from "effect";
import { z } from "zod";
import { ObservationSink as ObservationSinkTag } from "./ports";

const DeliveryFailure = z.object({
  eventName: z.string(),
  error: z.string(),
  reporterError: z.string().optional(),
});
type DeliveryFailure = z.infer<typeof DeliveryFailure>;

/**
 * A scoped-sink failure is reported as data on the plane it failed on; this
 * runner-free package neither throws it nor logs it. Delivery of this event
 * is never reported again: a failing failure report is dropped.
 */
export const ObservationDeliveryFailed = BusEvent.define(
  "observation.delivery_failed",
  DeliveryFailure,
  { visibility: "internal" },
);

type FailureReporter = (error: Error, eventName: string) => void;

/** The payload plane of one observation: anything a descriptor schema can carry. */
type ObservationData = bigint | boolean | null | number | object | string | symbol | undefined;

/** One delivered observation: the event name, its declared visibility, and the payload untouched. */
export interface PublishedObservation {
  readonly name: string;
  readonly visibility?: BusEvent.Visibility;
  readonly data: ObservationData;
}

function describeFailure(value: ObservationData): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function asError(value: ObservationData): Error {
  return value instanceof Error ? value : new Error(describeFailure(value));
}

type SinkService = ObservationSink & Required<Pick<ObservationSink, "subscribe" | "scope">>;

export interface ObservationBus {
  /** The protocol-shaped port: synchronous lossy publish, callback subscriptions, identity scoping. */
  readonly sink: SinkService;
  /** Every observation as a Stream; `PubSub.subscribe` installs the finalizer in the caller's Scope. */
  readonly observations: Effect.Effect<Stream.Stream<PublishedObservation>, never, Scope.Scope>;
  /** One event's payloads as a Stream, optionally field-matched, scoped to the caller. */
  readonly stream: <T>(
    event: BusEvent.Descriptor<T>,
    options?: { readonly match?: Partial<T> },
  ) => Effect.Effect<Stream.Stream<T>, never, Scope.Scope>;
}

export interface ObservationBusOptions {
  /** Composition-root entropy for scoped event ids; never ambient. */
  readonly id: () => string;
  /** Composition-root time for scoped event stamps; never ambient. */
  readonly now: () => number;
  readonly onError?: FailureReporter;
  /**
   * #1305: the publication-decision seam. Called once per `publish` with
   * whether the observation was enqueued; rung 16 (#1314) counts skipped
   * publications without subscribing (which would create interest itself).
   */
  readonly onPublish?: (eventName: string, delivered: boolean) => void;
}

/** A callback subscriber threw: logged on the subscriber's own fiber, never the publisher's. */
export class ObservationSubscriberFailure extends Data.TaggedError("ObservationSubscriberFailure")<{
  readonly eventName: string;
  readonly cause: string;
}> {}

/**
 * The session observation bus (#1249): one unbounded `PubSub` per owning
 * Scope. Publication is synchronous, nonblocking and lossy — observations are
 * never journal-durable; `alarm` rows ride the ledger, not this plane.
 * Subscribers are Streams (or forked callback drains) whose lifetime is a
 * Scope: closing it shuts the PubSub down and interrupts every drain, so
 * overlapping generations unsubscribe independently at Scope closure.
 */
export const makeObservationBus = (
  options: ObservationBusOptions,
): Effect.Effect<ObservationBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<PublishedObservation>(),
      PubSub.shutdown,
    );
    const forkDrain = yield* FiberSet.makeRuntime<never, void, never>();
    // #1305: per-event-name subscriber interest. `observations` subscribes to
    // every event, so it holds one all-events count; `stream` (and the
    // callback `subscribe` built on it) knows its event name at subscribe
    // time, so it registers interest keyed by that name. Each count is exact:
    // incremented when a subscription is acquired, decremented by its
    // finalizer in the consumer's own Scope. `match` predicates are
    // deliberately NOT consulted at publish time (recorded deviation from
    // #1305 solution 6): the stream still filters by `match` on the consumer
    // side, so correctness is unchanged and the lossy-synchronous publish
    // never pays for predicate evaluation.
    let allEventsInterest = 0;
    const namedInterest = new Map<string, number>();
    const subscription = (register: () => void, deregister: () => void) =>
      Effect.map(
        Effect.acquireRelease(
          Effect.tap(PubSub.subscribe(pubsub), () => Effect.sync(register)),
          () => Effect.sync(deregister),
        ),
        Stream.fromSubscription,
      );
    const observations = subscription(
      () => {
        allEventsInterest += 1;
      },
      () => {
        allEventsInterest -= 1;
      },
    );
    const stream = <T>(
      event: BusEvent.Descriptor<T>,
      streamOptions?: { readonly match?: Partial<T> },
    ) =>
      Effect.map(
        subscription(
          () => {
            namedInterest.set(event.name, (namedInterest.get(event.name) ?? 0) + 1);
          },
          () => {
            const remaining = (namedInterest.get(event.name) ?? 0) - 1;
            if (remaining <= 0) namedInterest.delete(event.name);
            else namedInterest.set(event.name, remaining);
          },
        ),
        (all) =>
          all.pipe(
            Stream.filter((published) => published.name === event.name),
            Stream.map((published) => published.data as T),
            Stream.filter(
              (data) => streamOptions?.match === undefined || matches(data, streamOptions.match),
            ),
          ),
      );
    const sink: SinkService = {
      publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
        // #1305: no matching subscriber, no publication. A PubSub whose
        // subscribers all filter this name out drops the value after the
        // copy; skipping here is semantically identical — and a large
        // payload is never serialized onto a plane nobody drains. The
        // lossy-synchronous contract is unchanged.
        const delivered = allEventsInterest > 0 || namedInterest.has(event.name);
        options.onPublish?.(event.name, delivered);
        if (!delivered) return;
        PubSub.publishUnsafe(pubsub, {
          name: event.name,
          ...(event.visibility === undefined ? {} : { visibility: event.visibility }),
          data: data as ObservationData,
        });
      },
      subscribe<T>(
        event: BusEvent.Descriptor<T>,
        handler: (data: T) => void,
        subscribeOptions?: { match?: Partial<T> },
      ): () => void {
        const fiber = forkDrain(
          Effect.scoped(
            Effect.flatMap(
              stream(event, subscribeOptions),
              Stream.runForEach((data) =>
                Effect.suspend(() => {
                  try {
                    handler(data);
                    return Effect.void;
                  } catch (cause) {
                    return Effect.logError(
                      new ObservationSubscriberFailure({
                        eventName: event.name,
                        cause: describeFailure(cause as ObservationData),
                      }),
                    );
                  }
                }),
              ),
            ),
          ),
        );
        return () => fiber.interruptUnsafe();
      },
      scope: (identity) => scopeObservation(sink, identity, options),
    };
    return { sink, observations, stream };
  });

/** The bus as a Layer over the kernel `ObservationSink` service: app-lifetime root or per-generation. */
export const observationBusLayer = (
  options: ObservationBusOptions,
): Layer.Layer<ObservationSinkTag> =>
  Layer.effect(ObservationSinkTag, Effect.map(makeObservationBus(options), (bus) => bus.sink));

function exposeFailure(sink: ObservationSink, failure: DeliveryFailure): void {
  if (failure.eventName === ObservationDeliveryFailed.name) return;
  try {
    sink.publish(ObservationDeliveryFailed, failure);
  } catch {
    // The plane itself is unavailable; there is nothing left to report to.
  }
}

/** An injected reporter owns the failure; if it throws, both failures reach the plane. */
function reportObservationFailure(
  sink: ObservationSink,
  error: Error,
  eventName: string,
  report: FailureReporter | undefined,
): void {
  if (report === undefined) {
    exposeFailure(sink, { eventName, error: describeFailure(error) });
    return;
  }
  try {
    report(error, eventName);
  } catch (reporterError) {
    exposeFailure(sink, {
      eventName,
      error: describeFailure(error),
      reporterError: describeFailure(reporterError as ObservationData),
    });
  }
}

function matches<T>(data: T, match: Partial<T>): boolean {
  if (data === null || typeof data !== "object") return false;
  for (const key of Object.keys(match) as Array<keyof T>) {
    if (data[key] !== match[key]) return false;
  }
  return true;
}

interface ScopeObservationOptions {
  readonly now: () => number;
  readonly id: () => string;
  readonly onError?: FailureReporter;
}

export function scopeObservation(
  sink: ObservationSink,
  identity: Readonly<BusEvent.Metadata>,
  options: ScopeObservationOptions,
): ObservationSink {
  const { now, id } = options;

  const subscribe = sink.subscribe?.bind(sink);
  const scoped: ObservationSink = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
      try {
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          throw new TypeError("scoped observation payload must be an object");
        }
        const stamp = { eventId: id(), time: now(), ...identity };
        sink.publish(event, { ...data, ...stamp });
      } catch (error) {
        reportObservationFailure(sink, asError(error as ObservationData), event.name, options.onError);
      }
    },
    scope(childIdentity) {
      return scopeObservation(sink, { ...identity, ...childIdentity }, options);
    },
    ...(subscribe === undefined ? {} : { subscribe }),
  };
  return scoped;
}

/** Invoked only after the consuming inbox/action transaction returns its receipt. */
export function observeDrained(
  rows: readonly Inbox.Row[],
  turnId: string,
  boundary: SessionTurn.Boundary,
  at: number,
  sink: ObservationSink,
  id: () => string,
): void {
  for (const row of rows) {
    const scoped = scopeObservation(
      sink,
      { sessionId: row.sessionId, turnId },
      { now: () => at, id },
    );
    scoped.publish(Gateway.MessageObserved, {
      kind: "message.drained",
      messageId: row.id,
      queueMs: Math.max(0, at - row.createdAt),
      boundary,
    });
  }
}
