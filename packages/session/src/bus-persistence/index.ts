import { flushBusPersistence, startBusPersistence, stopBusPersistence } from "./runtime-state.js";
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
}
