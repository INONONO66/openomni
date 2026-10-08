/**
 * #1305 bus interest gate: a publish with zero matching subscriber interest
 * for that event name enqueues nothing — the payload never reaches the
 * PubSub — and the decision is observable through the `onPublish` seam
 * rung 16 measures with. Wildcard `observations` counts for every name.
 */
import { describe, expect, it } from "bun:test";
import { BusEvent } from "@openomni/protocol";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { z } from "zod";
import { makeObservationBus } from "../../src/core/bus";
import { runTestPromise } from "../helpers/isolated";

const TestEvent = BusEvent.define(
  "test.bus.interest",
  z.object({ sessionId: z.string(), value: z.number() }),
);
const OtherEvent = BusEvent.define(
  "test.bus.other",
  z.object({ sessionId: z.string(), value: z.number() }),
);

function sources(published: Array<{ name: string; delivered: boolean }>) {
  let n = 0;
  return {
    id: () => `event-${++n}`,
    now: () => ++n,
    onPublish: (eventName: string, delivered: boolean) => {
      published.push({ name: eventName, delivered });
    },
  };
}

describe("observation bus interest (#1305)", () => {
  it("zero subscribers: publish is skipped, reported through onPublish, and nothing is retained", () =>
    runTestPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const published: Array<{ name: string; delivered: boolean }> = [];
          const bus = yield* makeObservationBus(sources(published));
          bus.sink.publish(TestEvent, { sessionId: "session-1", value: 1 });
          expect(published).toEqual([{ name: TestEvent.name, delivered: false }]);

          // A subscriber arriving later sees nothing of the skipped publish:
          // the zero-interest drop is permanent, exactly like PubSub's own
          // no-subscription drop.
          const seen: number[] = [];
          const got = yield* Deferred.make<void>();
          const stream = yield* bus.stream(TestEvent);
          yield* Effect.forkScoped(
            Stream.runForEach(stream, (data) =>
              Effect.suspend(() => {
                seen.push(data.value);
                return Deferred.succeed(got, void 0);
              }),
            ),
          );
          bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
          yield* Deferred.await(got);
          expect(seen).toEqual([2]);
          expect(published).toEqual([
            { name: TestEvent.name, delivered: false },
            { name: TestEvent.name, delivered: true },
          ]);
        }),
      ),
    ));

  it("interest ends with the subscriber's Scope: publishes skip again after closure", () =>
    runTestPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const published: Array<{ name: string; delivered: boolean }> = [];
          const bus = yield* makeObservationBus(sources(published));
          const scope = yield* Scope.make();
          yield* bus.stream(TestEvent).pipe(Scope.provide(scope));
          bus.sink.publish(TestEvent, { sessionId: "session-1", value: 1 });
          expect(published.at(-1)).toEqual({ name: TestEvent.name, delivered: true });

          yield* Scope.close(scope, Exit.void);
          bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
          expect(published.at(-1)).toEqual({ name: TestEvent.name, delivered: false });
        }),
      ),
    ));

  it("interest is per event name: a subscriber for A alone drops a publish of B", () =>
    runTestPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const published: Array<{ name: string; delivered: boolean }> = [];
          const bus = yield* makeObservationBus(sources(published));
          yield* bus.stream(TestEvent);
          bus.sink.publish(OtherEvent, { sessionId: "session-1", value: 1 });
          bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
          expect(published).toEqual([
            { name: OtherEvent.name, delivered: false },
            { name: TestEvent.name, delivered: true },
          ]);
        }),
      ),
    ));

  it("wildcard observations registers interest for every event name", () =>
    runTestPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const published: Array<{ name: string; delivered: boolean }> = [];
          const bus = yield* makeObservationBus(sources(published));
          yield* bus.observations;
          bus.sink.publish(OtherEvent, { sessionId: "session-1", value: 1 });
          bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
          expect(published).toEqual([
            { name: OtherEvent.name, delivered: true },
            { name: TestEvent.name, delivered: true },
          ]);
        }),
      ),
    ));

  it("callback subscribers count as interest for the drain's lifetime", () =>
    runTestPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const published: Array<{ name: string; delivered: boolean }> = [];
          const bus = yield* makeObservationBus(sources(published));
          const got = Promise.withResolvers<number>();
          const unsubscribe = bus.sink.subscribe(TestEvent, (data) => got.resolve(data.value));
          // Await actual interest, not timing: subscribe forks its drain, so
          // publish only counts as delivered once the subscription is live.
          yield* Effect.gen(function* () {
            for (;;) {
              bus.sink.publish(TestEvent, { sessionId: "session-1", value: 7 });
              if (published.at(-1)?.delivered === true) return;
              yield* Effect.yieldNow;
            }
          });
          expect(yield* Effect.promise(() => got.promise)).toBe(7);
          unsubscribe();
        }),
      ),
    ));
});
