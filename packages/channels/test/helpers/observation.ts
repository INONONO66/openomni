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

  export function withIsolation<T>(operation: () => T): T {
    return busScope.run(createState(), operation);
  }

}

