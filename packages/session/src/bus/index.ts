import { BusEvent } from "@openomni/protocol";

export { BusEvent };

export namespace Bus {
  type Handler = (data: unknown) => void;

  export interface PublishedDescriptor {
    readonly name: string;
    readonly schema: unknown;
    readonly visibility?: BusEvent.Visibility;
  }

  type Observer = (event: PublishedDescriptor, data: unknown) => void;

  export type ErrorPhase = "observer" | "subscriber";

  export interface ErrorFact {
    readonly eventName: string;
    readonly phase: ErrorPhase;
    readonly error: string;
  }

  export type ErrorSink = (fact: ErrorFact) => void;

  interface Subscription {
    handler: Handler;
    match?: Record<string, unknown>;
  }

  const subscribers = new Map<string, Set<Subscription>>();
  const observers = new Set<Observer>();
  let errorSink: ErrorSink | undefined;
  let observerFailureCount = 0;
  let subscriberFailureCount = 0;

  export function publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    const subs = subscribers.get(event.name);
    const observerSnapshot = [...observers];

    if (observerSnapshot.length > 0) {
      for (const observer of observerSnapshot) {
        queueMicrotask(() => {
          try {
            observer(event, data);
          } catch (err) {
            reportFailure(event.name, "observer", err);
          }
        });
      }
    }

    if (!subs) return;

    const snapshot = [...subs];

    for (const sub of snapshot) {
      queueMicrotask(() => {
        try {
          if (sub.match && !matches(data, sub.match)) return;
          sub.handler(data);
        } catch (err) {
          reportFailure(event.name, "subscriber", err);
        }
      });
    }
  }

  export function subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void {
    let subs = subscribers.get(event.name);
    if (!subs) {
      subs = new Set();
      subscribers.set(event.name, subs);
    }
    const subscription: Subscription = {
      handler: handler as Handler,
      match: options?.match as Record<string, unknown> | undefined,
    };
    subs.add(subscription);
    const captured = subs;
    const eventName = event.name;
    return () => {
      captured.delete(subscription);
      if (captured.size === 0 && subscribers.get(eventName) === captured) {
        subscribers.delete(eventName);
      }
    };
  }

  export function observe(handler: Observer): () => void {
    observers.add(handler);
    return () => {
      observers.delete(handler);
    };
  }

  /** Installs the process-local diagnostic sink used for subsequent dispatch failures. */
  export function setErrorSink(sink: ErrorSink | undefined): void {
    errorSink = sink;
  }

  export function reset(): void {
    subscribers.clear();
    observers.clear();
    errorSink = undefined;
    observerFailureCount = 0;
    subscriberFailureCount = 0;
  }

  /** Diagnostic counters for tests and runtime observability; not control-flow state. */
  export function stats(): {
    readonly subscriberEventCount: number;
    readonly subscriberCount: number;
    readonly observerCount: number;
  } {
    let subscriberCount = 0;
    for (const subs of subscribers.values()) {
      subscriberCount += subs.size;
    }

    return {
      subscriberEventCount: subscribers.size,
      subscriberCount,
      observerCount: observers.size,
    };
  }

  /** Monotonic dispatch-failure counters; reset() starts a new diagnostic epoch. */
  export function failureStats(): {
    readonly observerFailureCount: number;
    readonly subscriberFailureCount: number;
  } {
    return { observerFailureCount, subscriberFailureCount };
  }

  function reportFailure(eventName: string, phase: ErrorPhase, error: unknown): void {
    if (phase === "observer") {
      observerFailureCount += 1;
    } else {
      subscriberFailureCount += 1;
    }

    const fact: ErrorFact = { eventName, phase, error: stringifyError(error) };
    if (!errorSink) {
      console.warn("Bus dispatch error", fact);
      return;
    }

    try {
      errorSink(fact);
    } catch (sinkError) {
      console.error("Bus error sink failure", {
        ...fact,
        sinkError: stringifyError(sinkError),
      });
    }
  }

  function stringifyError(error: unknown): string {
    try {
      return String(error);
    } catch {
      return "Unstringifiable error";
    }
  }

  function matches(data: unknown, match: Record<string, unknown>): boolean {
    if (data === null || typeof data !== "object") return false;
    const obj = data as Record<string, unknown>;
    for (const [key, expected] of Object.entries(match)) {
      if (obj[key] !== expected) return false;
    }
    return true;
  }
}
