import { closeSessions, type SessionRuntime } from "@openomni/agent";
import { Effect } from "effect";
import { lifecycleFailure } from "./runtime";

export function shutdownSessions(runtime: SessionRuntime, recovery: Promise<void>) {
  // Agent hook integration: replace this boundary with the native cancellation,
  // interruption, injected-clock grace and fenced outcome_unknown shutdown Effect.
  return Effect.all(
    [
      Effect.tryPromise({
        try: () => closeSessions(runtime),
        catch: lifecycleFailure("sessions.close"),
      }),
      Effect.tryPromise({ try: () => recovery, catch: lifecycleFailure("sessions.recovery") }),
    ],
    { concurrency: "unbounded", mode: "validate", discard: true },
  );
}
