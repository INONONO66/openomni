import { Context, Effect } from "effect";

export class RawToolSlots extends Context.Tag("@openomni/agent/RawToolSlots")<
  RawToolSlots,
  ReturnType<typeof createRawSlots>
>() {}

/** Slots outlive interrupted fibers; raw callbacks only settle ownership, never ledger results. */
export function createRawSlots(retain?: (settlement: Promise<void>) => void) {
  const pending = new Set<symbol>();
  const listeners = new Set<() => void>();
  function open() {
    const key = Symbol();
    const completion = Promise.withResolvers<void>();
    pending.add(key);
    retain?.(completion.promise);
    return () => {
      if (!pending.delete(key)) return;
      completion.resolve();
      if (pending.size === 0) for (const notify of [...listeners]) notify();
    };
  }
  const awaitSettled = Effect.async<void>((resume) => {
    const notify = () => resume(Effect.void);
    listeners.add(notify);
    if (pending.size === 0) notify();
    return Effect.sync(() => listeners.delete(notify));
  });
  return { open, awaitSettled, pending: () => pending.size };
}
