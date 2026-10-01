import type { EpochMs } from "./time.js";

/** Wall-clock epoch milliseconds supplied by a runtime owner. */
export type Clock = () => EpochMs;

/** Opaque identity supplied by the package that owns its runtime lifecycle. */
export type IdSource = () => string;

/**
 * Once-only abort subscription; the returned thunk detaches it. An already
 * aborted signal fires `listener` at once and registers nothing.
 */
export function listenForAbort(signal: AbortSignal, listener: () => void): () => void {
  if (signal.aborted) {
    listener();
    return () => undefined;
  }
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}
