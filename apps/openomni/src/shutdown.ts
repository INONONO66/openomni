import { closeSessions, type SessionRuntime } from "@openomni/agent";
import { Effect } from "effect";
import { lifecycleFailure } from "./runtime";

export function shutdownSessions(runtime: SessionRuntime, recovery: Promise<void>) {
  // Recovery and retained raw work are owned by the app Scope, not this waiter.
  return Effect.all(
    [
      closeSessions(runtime),
      Effect.tryPromise({ try: () => recovery, catch: lifecycleFailure("sessions.recovery") }),
    ],
    { concurrency: "unbounded", mode: "validate", discard: true },
  );
}
