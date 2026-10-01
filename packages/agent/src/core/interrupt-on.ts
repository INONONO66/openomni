import { listenForAbort } from "@openomni/protocol";
import { Effect } from "effect";

/** Resumes with `outcome` when `signal` aborts; interrupting the waiter detaches the listener. */
export function onAbort<A, E = never>(signal: AbortSignal, outcome: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume) => Effect.sync(listenForAbort(signal, () => resume(outcome))));
}

/** Interrupts the racing fiber when `signal` aborts: `work.pipe(Effect.raceFirst(interruptOn(signal)))`. */
export function interruptOn(signal: AbortSignal): Effect.Effect<never> {
  return onAbort(signal, Effect.interrupt);
}
