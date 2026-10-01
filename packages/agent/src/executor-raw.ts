import { Context, Deferred, Effect, Exit } from "effect";

export class RawToolSlots extends Context.Service<
  RawToolSlots,
  ReturnType<typeof createRawSlots>
>()("@openomni/agent/RawToolSlots") {}

/** Slots outlive interrupted fibers; raw callbacks only settle ownership, never ledger results. */
export function createRawSlots(retain?: (settlement: Promise<void>) => void) {
  const pending = new Map<symbol, Deferred.Deferred<void>>();
  function open() {
    const key = Symbol("raw-tool-slot");
    const completion = Promise.withResolvers<void>();
    const settled = Deferred.makeUnsafe<void>();
    pending.set(key, settled);
    retain?.(completion.promise);
    return () => {
      if (!pending.delete(key)) return;
      completion.resolve();
      Deferred.doneUnsafe(settled, Exit.void);
    };
  }
  // Re-check after the snapshot drains: slots opened meanwhile must settle too.
  const awaitSettled: Effect.Effect<void> = Effect.suspend(() => pending.size === 0 ? Effect.void
    : Effect.forEach([...pending.values()], Deferred.await, { discard: true }).pipe(Effect.andThen(awaitSettled)));
  return { open, awaitSettled, pending: () => pending.size };
}
