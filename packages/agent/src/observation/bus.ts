import type { BusEvent, ObservationSink } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";

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

function isEventData<T, U>(
  expected: BusEvent.Descriptor<T>,
  published: BusEvent.Descriptor<U>,
  _data: U,
): _data is U & T {
  return expected.name === published.name;
}

export interface ObservationBus extends ObservationSink {
  subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void;
  observe(handler: Observer): () => void;
  reset(): void;
  withIsolation<T>(operation: () => T): T;
}

export namespace ObservationBus {
  export interface PublishedDescriptor {
    readonly name: string;
    readonly schema: { readonly safeParse: (value: BusData) => ParseResult<BusData> };
    readonly visibility?: BusEvent.Visibility;
  }
}

export function createObservationBus(): ObservationBus {
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
        queueMicrotask(() => deliver(() => observer(published, publishedData), event.name));
      }
      for (const subscription of [...(state.subscribers.get(event.name) ?? [])]) {
        queueMicrotask(() => deliver(() => subscription.handler(event, data), event.name));
      }
    },
    scope(identity) {
      return scopeObservation(bus, identity);
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

function deliver(operation: () => void, eventName: string): void {
  try {
    operation();
  } catch (error) {
    console.warn("ObservationBus handler error", { event: eventName, error: String(error) });
  }
}

function matches<T>(data: T, match: Partial<T>): boolean {
  if (data === null || typeof data !== "object") return false;
  for (const key of Object.keys(match) as Array<keyof T>) {
    if (data[key] !== match[key]) return false;
  }
  return true;
}

export const Bus = createObservationBus();

export interface ScopeObservationOptions {
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly onError?: (error: Error, eventName: string) => void;
}

export function scopeObservation(
  sink: ObservationSink,
  identity: Readonly<BusEvent.Metadata>,
  options: ScopeObservationOptions = {},
): ObservationSink {
  const clock = options.clock ?? Date.now;
  const entropy = options.entropy ?? (() => crypto.randomUUID());
  const report = options.onError ?? ((error, eventName) =>
    console.warn("observation emit failed", { eventName, error: String(error) }));

  const scoped: ObservationSink = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
      try {
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          throw new TypeError("scoped observation payload must be an object");
        }
        const payload = { ...data, eventId: entropy(), time: clock(), ...identity };
        sink.publish(event, payload as T);
      } catch (error) {
        try {
          report(error instanceof Error ? error : new Error(String(error)), event.name);
        } catch {
          // Observation failures never alter the observed operation.
        }
      }
    },
    scope(childIdentity) {
      return scopeObservation(sink, { ...identity, ...childIdentity }, options);
    },
    ...(sink.subscribe === undefined
      ? {}
      : {
          subscribe<T>(
            event: BusEvent.Descriptor<T>,
            handler: (data: T) => void,
            subscriptionOptions?: { match?: Partial<T> },
          ): () => void {
            return sink.subscribe?.(event, handler, subscriptionOptions) ?? (() => undefined);
          },
        }),
  };
  return scoped;
}

interface CollectingObservationSink extends ObservationSink {
  readonly events: readonly { readonly name: string; readonly data: BusData }[];
  named(name: string): readonly BusData[];
  reset(): void;
}

function observationCollector(): CollectingObservationSink {
  const events: Array<{ readonly name: string; readonly data: BusData }> = [];
  return {
    publish(event, data) {
      events.push({ name: event.name, data: toBusData(data) });
    },
    scope(identity) {
      return scopeObservation(this, identity);
    },
    events,
    named: (name) => events.filter((event) => event.name === name).map((event) => event.data),
    reset: () => {
      events.length = 0;
    },
  };
}

export const collector = observationCollector;

export function newTraceId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function noopObservationSink(): ObservationSink {
  const sink: ObservationSink = {
    publish: () => undefined,
    scope: () => sink,
  };
  return sink;
}

export const noopSink = noopObservationSink;
