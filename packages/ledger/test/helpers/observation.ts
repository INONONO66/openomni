import type { BusEvent } from "@openomni/protocol";

type Datum = object | string | number | boolean | bigint | symbol | null | undefined;
type Subscriber = (event: BusEvent.Descriptor<never>, data: never) => void;
type Observer = (event: { readonly name: string }, data: Datum) => void;

const subscriptions = new Map<string, Set<Subscriber>>();
const observers = new Set<Observer>();

function publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
  for (const observer of [...observers]) queueMicrotask(() => observer(event, data as Datum));
  for (const subscriber of [...(subscriptions.get(event.name) ?? [])]) {
    queueMicrotask(() => subscriber(event as BusEvent.Descriptor<never>, data as never));
  }
}

function subscribe<T>(
  event: BusEvent.Descriptor<T>,
  handler: (data: T) => void,
  options?: { match?: Partial<T> },
): () => void {
  const set = subscriptions.get(event.name) ?? new Set<Subscriber>();
  const subscriber: Subscriber = (_descriptor, data) => {
    if (options?.match !== undefined && !matches(data, options.match)) return;
    handler(data);
  };
  set.add(subscriber);
  subscriptions.set(event.name, set);
  return () => set.delete(subscriber);
}

function matches<T>(data: T, expected: Partial<T>): boolean {
  if (data === null || typeof data !== "object") return false;
  return Object.entries(expected).every(([key, value]) => Reflect.get(data, key) === value);
}

export const Bus = {
  publish,
  subscribe,
  observe(observer: Observer): () => void {
    observers.add(observer);
    return () => observers.delete(observer);
  },
  reset(): void {
    subscriptions.clear();
    observers.clear();
  },
};
