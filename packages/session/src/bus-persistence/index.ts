import {
  busPersistenceStats,
  flushBusPersistence,
  startBusPersistence,
  stopBusPersistence,
} from "./runtime-state.js";
import type { BusPersistenceOptions } from "./types.js";

export namespace BusPersistence {
  export function start(options: BusPersistenceOptions = {}): () => void {
    return startBusPersistence(options);
  }

  export function stop(): void {
    stopBusPersistence();
  }

  export async function flush(): Promise<void> {
    await flushBusPersistence();
  }

  /** Writer drop counter — every row lost to a persist failure counts here. */
  export function stats(): { readonly droppedEventCount: number } {
    return busPersistenceStats();
  }
}
