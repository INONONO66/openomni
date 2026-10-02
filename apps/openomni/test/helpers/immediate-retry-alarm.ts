import { Effect } from "effect";
import type { Session } from "@openomni/agent";
type SessionRuntime = Session.SessionRuntime;

/** Scheduling is outside these in-memory fixtures; retries still use native Effects. */
export const immediateRetryAlarm: NonNullable<SessionRuntime["retryAlarm"]> = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};
