export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
};

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Bounded failure guard for awaited exact signals: the awaited promise resolves on the real
    // event; the timer only converts "signal never fired" into a labeled rejection, never a wait.
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
