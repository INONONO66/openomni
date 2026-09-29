export function listenForAbort(signal: AbortSignal, listener: () => void): () => void {
  signal.addEventListener("abort", listener, { once: true });
  if (signal.aborted) listener();
  return () => signal.removeEventListener("abort", listener);
}
