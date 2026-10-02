import { BusEvent, type ObservationSink, Gateway, type Inbox, type SessionTurn } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

// ─── from observation/bus.ts (#1247) ───
const DeliveryFailure = z.object({
  eventName: z.string(),
  error: z.string(),
  reporterError: z.string().optional(),
});
type DeliveryFailure = z.infer<typeof DeliveryFailure>;

/**
 * A subscriber or sink failure is reported as data on the plane it failed on;
 * this runner-free package neither throws it nor logs it. Delivery of this
 * event is never reported again: a failing failure report is dropped.
 */
export const ObservationDeliveryFailed = BusEvent.define(
  "observation.delivery_failed",
  DeliveryFailure,
  { visibility: "internal" },
);

type FailureReporter = (error: Error, eventName: string) => void;

type BusData = bigint | boolean | null | number | object | string | symbol | undefined;
type ParseResult<T> = { readonly data: T; readonly success: true } | { readonly success: false };
type Handler = <T>(event: BusEvent.Descriptor<T>, data: T) => void;
type Observer = (event: ObservationBus.PublishedDescriptor, data: BusData) => void;

interface Subscription {
  readonly handler: Handler;
}

interface BusState {
  readonly subscribers: Map<string, Set<Subscription>>;
  readonly observers: Set<Observer>;
}

function createState(): BusState {
  return { subscribers: new Map(), observers: new Set() };
}

function toBusData<T>(value: T): BusData {
  if (value === null) return null;
  if (typeof value === "object" || typeof value === "function") return value;
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (typeof value === "symbol") return value;
  return undefined;
}

function describeFailure(value: BusData): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function asError(value: BusData): Error {
  return value instanceof Error ? value : new Error(describeFailure(value));
}

function isEventData<T, U>(
  expected: BusEvent.Descriptor<T>,
  published: BusEvent.Descriptor<U>,
  _data: U,
): _data is U & T {
  return expected.name === published.name;
}

export interface ObservationBus extends ObservationSink {
  scope(identity: Readonly<BusEvent.Metadata>): ObservationSink;
  subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void;
  observe(handler: Observer): () => void;
  reset(): void;
  withIsolation<T>(operation: () => T): T;
}

namespace ObservationBus {
  export interface PublishedDescriptor {
    readonly name: string;
    readonly schema: { readonly safeParse: (value: BusData) => ParseResult<BusData> };
    readonly visibility?: BusEvent.Visibility;
  }
}

export interface ObservationBusOptions {
  /** Composition-root entropy for scoped event ids; never ambient. */
  readonly id: () => string;
  /** Composition-root time for scoped event stamps; never ambient. */
  readonly now: () => number;
  readonly onError?: FailureReporter;
}

export function createObservationBus(options: ObservationBusOptions): ObservationBus {
  const onError = options.onError;
  const rootState = createState();
  const local = new AsyncLocalStorage<BusState>();
  const current = () => local.getStore() ?? rootState;

  const bus: ObservationBus = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
      const state = current();
      const published: ObservationBus.PublishedDescriptor = {
        name: event.name,
        schema: {
          safeParse(value) {
            const parsed = event.schema.safeParse(value);
            return parsed.success
              ? { success: true, data: toBusData(parsed.data) }
              : { success: false };
          },
        },
        ...(event.visibility === undefined ? {} : { visibility: event.visibility }),
      };
      const publishedData = toBusData(data);
      for (const observer of [...state.observers]) {
        queueMicrotask(() => deliver(bus, () => observer(published, publishedData), event.name, onError));
      }
      for (const subscription of [...(state.subscribers.get(event.name) ?? [])]) {
        queueMicrotask(() => deliver(bus, () => subscription.handler(event, data), event.name, onError));
      }
    },
    scope(identity) {
      return scopeObservation(bus, identity, options);
    },
    subscribe<T>(
      event: BusEvent.Descriptor<T>,
      handler: (data: T) => void,
      options?: { match?: Partial<T> },
    ): () => void {
      const state = current();
      const subscriptions = state.subscribers.get(event.name) ?? new Set<Subscription>();
      state.subscribers.set(event.name, subscriptions);
      const subscription: Subscription = {
        handler(published, data) {
          if (!isEventData(event, published, data)) return;
          if (options?.match !== undefined && !matches(data, options.match)) return;
          handler(data);
        },
      };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
        if (subscriptions.size === 0 && state.subscribers.get(event.name) === subscriptions) {
          state.subscribers.delete(event.name);
        }
      };
    },
    observe(handler) {
      const state = current();
      state.observers.add(handler);
      return () => state.observers.delete(handler);
    },
    reset() {
      const state = current();
      state.subscribers.clear();
      state.observers.clear();
    },
    withIsolation<T>(operation: () => T): T {
      return local.run(createState(), operation);
    },
  };
  return bus;
}

function deliver(
  sink: ObservationSink,
  operation: () => void,
  eventName: string,
  onError: FailureReporter | undefined,
): void {
  try {
    operation();
  } catch (error) {
    reportObservationFailure(sink, asError(toBusData(error)), eventName, onError);
  }
}

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
      reporterError: describeFailure(toBusData(reporterError)),
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
        reportObservationFailure(sink, asError(toBusData(error)), event.name, options.onError);
      }
    },
    scope(childIdentity) {
      return scopeObservation(sink, { ...identity, ...childIdentity }, options);
    },
    ...(subscribe === undefined ? {} : { subscribe }),
  };
  return scoped;
}

// ─── from session-message-observation.ts (#1247) ───
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

