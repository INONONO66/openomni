import type { BusEvent } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";

type Datum = object | string | number | boolean | bigint | symbol | null | undefined;
type Watcher = (event: { readonly name: string }, data: Datum) => void;
type State = { readonly watchers: Set<Watcher> };

const root: State = { watchers: new Set() };
const scope = new AsyncLocalStorage<State>();
const state = () => scope.getStore() ?? root;

export const Bus = {
  publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    for (const watcher of [...state().watchers]) {
      queueMicrotask(() => watcher(event, data as Datum));
    }
  },
  observe(watcher: Watcher): () => void {
    const captured = state();
    captured.watchers.add(watcher);
    return () => captured.watchers.delete(watcher);
  },
  reset(): void {
    state().watchers.clear();
  },
  withIsolation<T>(operation: () => T): T {
    return scope.run({ watchers: new Set() }, operation);
  },
};
