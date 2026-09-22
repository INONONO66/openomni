import { Effect } from "effect";
import type { SessionRuntime } from "@openomni/agent";

/** Scheduling is outside these in-memory fixtures; retries still use native Effects. */
export const immediateRetryAlarm: NonNullable<SessionRuntime["retryAlarm"]> = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};
