export function createAbortError(): Error {
  const error = new Error("resident run aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

export function abortRace(signal: AbortSignal | undefined): {
  readonly promise: Promise<never>;
  readonly cleanup: () => void;
} {
  if (!signal) {
    return {
      promise: new Promise<never>(() => undefined),
      cleanup: () => undefined,
    };
  }
  if (signal.aborted) {
    return { promise: Promise.reject(createAbortError()), cleanup: () => undefined };
  }
  let cleanup: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cleanup };
}
