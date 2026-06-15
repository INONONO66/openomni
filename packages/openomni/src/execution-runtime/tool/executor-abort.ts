import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";

export function createAbortError(): Error {
  const error = new Error("Tool execution aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason;
}

export function linkAbortSignals(
  localSignal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  if (!parentSignal) return { signal: localSignal, cleanup: () => undefined };

  const linked = new AbortController();
  const forwardLocalAbort = () => {
    if (!linked.signal.aborted) linked.abort(abortReason(localSignal));
  };
  const forwardParentAbort = () => {
    if (!linked.signal.aborted) linked.abort(abortReason(parentSignal));
  };

  if (localSignal.aborted) forwardLocalAbort();
  if (parentSignal.aborted) forwardParentAbort();

  localSignal.addEventListener("abort", forwardLocalAbort, { once: true });
  parentSignal.addEventListener("abort", forwardParentAbort, { once: true });

  return {
    signal: linked.signal,
    cleanup: () => {
      localSignal.removeEventListener("abort", forwardLocalAbort);
      parentSignal.removeEventListener("abort", forwardParentAbort);
    },
  };
}

export async function enforceTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: (error: ToolRuntimePolicyMiddleware.TimeoutError) => void,
): Promise<T> {
  if (signal?.aborted) throw createAbortError();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutFired = false;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => finish(() => reject(createAbortError()));
    const timer = globalThis.setTimeout(() => {
      timeoutFired = true;
      const error = new ToolRuntimePolicyMiddleware.TimeoutError(timeoutMs);
      finish(() => reject(error));
      try {
        onTimeout(error);
      } catch {
        return;
      }
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => {
        if (timeoutFired) return;
        finish(() => reject(error));
      },
    );
  });
}
