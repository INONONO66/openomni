import type { BusEvent } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";

type BusData =
  | bigint
  | boolean
  | null
  | number
  | object
  | string
  | symbol
  | undefined;

type ParseResult<T> = { readonly data: T; readonly success: true } | { readonly success: false };

type Handler = <T>(event: BusEvent.Descriptor<T>, data: T) => void;
type Observer = (event: Bus.PublishedDescriptor, data: BusData) => void;

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

interface Subscription {
  handler: Handler;
}

type BusState = {
  subscribers: Map<string, Set<Subscription>>;
  observers: Set<Observer>;
};

const rootState = createState();
const busScope = new AsyncLocalStorage<BusState>();

function createState(): BusState {
  return { subscribers: new Map(), observers: new Set() };
}

function currentState(): BusState {
  return busScope.getStore() ?? rootState;
}

export namespace Bus {
  export type Data = BusData;

  export interface PublishedDescriptor {
    readonly name: string;
    readonly schema: { readonly safeParse: (value: BusData) => ParseResult<BusData> };
    readonly visibility?: BusEvent.Visibility;
  }

  export function publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    const state = currentState();
    const subs = state.subscribers.get(event.name);
    if (state.observers.size > 0) {
      const publishedEvent: PublishedDescriptor = {
        name: event.name,
        schema: {
          safeParse: (value) => {
            const parsed = event.schema.safeParse(value);
            return parsed.success
              ? { success: true, data: toBusData(parsed.data) }
              : { success: false };
          },
        },
        ...(event.visibility === undefined ? {} : { visibility: event.visibility }),
      };
      const publishedData = toBusData(data);
      const observerSnapshot = [...state.observers];
      for (const observer of observerSnapshot) {
        queueMicrotask(() => {
          try {
            observer(publishedEvent, publishedData);
          } catch (err) {
            console.warn("Bus observer error", { event: event.name, error: String(err) });
          }
        });
      }
    }

    if (!subs) return;

    const snapshot = [...subs];

    for (const sub of snapshot) {
      queueMicrotask(() => {
        try {
          sub.handler(event, data);
        } catch (err) {
          console.warn("Bus handler error", { event: event.name, error: String(err) });
        }
      });
    }
  }

  export function subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void {
    const state = currentState();
    let subs = state.subscribers.get(event.name);
    if (!subs) {
      subs = new Set();
      state.subscribers.set(event.name, subs);
    }
    const subscription: Subscription = {
      handler: (publishedEvent, data) => {
        if (!isEventData(event, publishedEvent, data)) return;
        if (options?.match && !matches(data, options.match)) return;
        handler(data);
      },
    };
    subs.add(subscription);
    const captured = subs;
    const eventName = event.name;
    return () => {
      captured.delete(subscription);
      if (captured.size === 0 && state.subscribers.get(eventName) === captured) {
        state.subscribers.delete(eventName);
      }
    };
  }

  export function observe(handler: Observer): () => void {
    const state = currentState();
    state.observers.add(handler);
    return () => {
      state.observers.delete(handler);
    };
  }

  export function reset(): void {
    const state = currentState();
    state.subscribers.clear();
    state.observers.clear();
  }

  /** Diagnostic counters for tests; no runtime consumer exists today. Not control-flow state. */
  export function stats(): {
    readonly subscriberEventCount: number;
    readonly subscriberCount: number;
    readonly observerCount: number;
  } {
    const state = currentState();
    let subscriberCount = 0;
    for (const subs of state.subscribers.values()) {
      subscriberCount += subs.size;
    }

    return {
      subscriberEventCount: state.subscribers.size,
      subscriberCount,
      observerCount: state.observers.size,
    };
  }

  export function withIsolation<T>(operation: () => T): T {
    return busScope.run(createState(), operation);
  }

  function matches<T>(data: T, match: Partial<T>): boolean {
    if (data === null || typeof data !== "object") return false;
    if (match === null || typeof match !== "object") return true;
    for (const key of Object.keys(match)) {
      if (Reflect.get(data, key) !== Reflect.get(match, key)) return false;
    }
    return true;
  }
}
