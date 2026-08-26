import type { BusEvent } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";

type Handler = (data: unknown) => void;
type Observer = (event: Bus.PublishedDescriptor, data: unknown) => void;

interface Subscription {
  handler: Handler;
  match?: Record<string, unknown>;
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
  export interface PublishedDescriptor {
    readonly name: string;
    readonly schema: unknown;
    readonly visibility?: BusEvent.Visibility;
  }

  export function publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    const state = currentState();
    const subs = state.subscribers.get(event.name);
    if (state.observers.size > 0) {
      const observerSnapshot = [...state.observers];
      for (const observer of observerSnapshot) {
        queueMicrotask(() => {
          try {
            observer(event, data);
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
          if (sub.match && !matches(data, sub.match)) return;
          sub.handler(data);
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
      handler: handler as Handler,
      match: options?.match as Record<string, unknown> | undefined,
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

  function matches(data: unknown, match: Record<string, unknown>): boolean {
    if (data === null || typeof data !== "object") return false;
    const obj = data as Record<string, unknown>;
    for (const [key, expected] of Object.entries(match)) {
      if (obj[key] !== expected) return false;
    }
    return true;
  }
}
