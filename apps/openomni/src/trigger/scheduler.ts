import { Trigger } from "@openomni/protocol";

/** Wall-clock facts consumed by the pure Trigger scheduler. */
export interface TriggerClock {
  now(): number;
}

/** One replaceable deadline per Trigger. */
export interface TriggerTimerPort {
  arm(key: string, dueAt: number, callback: () => void): void;
  cancel(key: string): void;
  cancelAll(): void;
}

export interface TriggerTimerBackend {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface TriggerTimerOptions {
  readonly maxDelayMs?: number;
  readonly onClockRollback?: (facts: {
    readonly key: string;
    readonly rawNow: number;
    readonly logicalNow: number;
  }) => void;
}

interface DeadlineEntry {
  readonly dueAt: number;
  readonly callback: () => void;
  readonly generation: number;
  logicalNow: number;
  handle?: unknown;
}

const nativeTimerBackend: TriggerTimerBackend = {
  set(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    const unref = (handle as unknown as { unref?: () => void }).unref;
    unref?.call(handle);
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Adapts the platform timer to Trigger's exact deadline semantics. Long delays
 * are segmented, every segment re-reads the clock, and generation checks make
 * a callback from a replaced handle harmless even when the platform delivers
 * it after cancellation.
 */
export function createTriggerTimerPort(
  clock: TriggerClock,
  backend: TriggerTimerBackend = nativeTimerBackend,
  options: TriggerTimerOptions = {},
): TriggerTimerPort {
  const maxDelayMs = options.maxDelayMs ?? Trigger.Constants.SET_TIMEOUT_MAX_MS;
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < 1) {
    throw new Error("Trigger timer maxDelayMs must be a positive safe integer");
  }

  const entries = new Map<string, DeadlineEntry>();
  let generation = 0;

  function clearEntryHandle(entry: DeadlineEntry): void {
    if (entry.handle === undefined) return;
    backend.clear(entry.handle);
    entry.handle = undefined;
  }

  function schedule(key: string, expectedGeneration: number): void {
    const entry = entries.get(key);
    if (entry === undefined || entry.generation !== expectedGeneration) return;

    const rawNow = clock.now();
    if (!Number.isSafeInteger(rawNow) || rawNow < 0) {
      throw new Error(`Trigger clock returned an invalid epoch: ${rawNow}`);
    }
    if (rawNow < entry.logicalNow) {
      options.onClockRollback?.({ key, rawNow, logicalNow: entry.logicalNow });
    } else {
      entry.logicalNow = rawNow;
    }

    const remaining = entry.dueAt - entry.logicalNow;
    if (remaining <= 0) {
      entries.delete(key);
      entry.handle = undefined;
      entry.callback();
      return;
    }

    const delay = Math.min(remaining, maxDelayMs);
    entry.handle = backend.set(delay, () => {
      const current = entries.get(key);
      if (current === undefined || current.generation !== expectedGeneration) return;
      current.handle = undefined;
      schedule(key, expectedGeneration);
    });
  }

  return {
    arm(key, dueAt, callback) {
      if (!Number.isSafeInteger(dueAt) || dueAt < 0) {
        throw new Error(`Trigger deadline is not a valid epoch: ${dueAt}`);
      }
      const previous = entries.get(key);
      if (previous !== undefined) clearEntryHandle(previous);
      const rawNow = clock.now();
      if (!Number.isSafeInteger(rawNow) || rawNow < 0) {
        throw new Error(`Trigger clock returned an invalid epoch: ${rawNow}`);
      }
      const entry: DeadlineEntry = {
        dueAt,
        callback,
        generation: ++generation,
        logicalNow: Math.max(rawNow, previous?.logicalNow ?? rawNow),
      };
      entries.set(key, entry);
      schedule(key, entry.generation);
    },
    cancel(key) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entries.delete(key);
      clearEntryHandle(entry);
    },
    cancelAll() {
      for (const entry of entries.values()) clearEntryHandle(entry);
      entries.clear();
    },
  };
}

/** Logical wall time cannot move behind a durable Trigger watermark. */
export function triggerLogicalNow(clock: TriggerClock, record: Trigger.Record): number {
  return Math.max(clock.now(), record.lastObservedAt);
}
