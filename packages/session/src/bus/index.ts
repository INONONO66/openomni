import { Log } from "../log/index.js";
import { BusEvent } from "@openomni/protocol";

export { BusEvent };

export namespace Bus {
  type Handler = (data: unknown) => void;

  export interface PublishedDescriptor {
    readonly name: string;
    readonly schema: unknown;
    readonly visibility?: BusEvent.Visibility;
  }

  type Observer = (event: PublishedDescriptor, data: unknown) => void;

  interface Subscription {
    handler: Handler;
    match?: Record<string, unknown>;
  }

  const subscribers = new Map<string, Set<Subscription>>();
  const observers = new Set<Observer>();

  export function publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    const subs = subscribers.get(event.name);
    const observerSnapshot = [...observers];

    if (observerSnapshot.length > 0) {
      for (const observer of observerSnapshot) {
        queueMicrotask(() => {
          try {
            observer(event, data);
          } catch (err) {
            Log.warn("Bus observer error", { event: event.name, error: String(err) });
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
          Log.warn("Bus handler error", { event: event.name, error: String(err) });
        }
      });
    }
  }

  export function subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void {
    let subs = subscribers.get(event.name);
    if (!subs) {
      subs = new Set();
      subscribers.set(event.name, subs);
    }
    const subscription: Subscription = {
      handler: handler as Handler,
      match: options?.match as Record<string, unknown> | undefined,
    };
    subs.add(subscription);
    const captured = subs;
    return () => {
      captured.delete(subscription);
    };
  }

  export function observe(handler: Observer): () => void {
    observers.add(handler);
    return () => {
      observers.delete(handler);
    };
  }

  export function reset(): void {
    subscribers.clear();
    observers.clear();
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
