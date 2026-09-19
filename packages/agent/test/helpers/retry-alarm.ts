import type { RetryAlarmPort } from "../../src/executor-retry-alarm";

/**
 * The one null durability stub for in-memory fixtures: it removes only retry
 * scheduling from scope. Durable retry.scheduled behavior is covered by
 * retry-rearm.test.ts, llm-attempts.test.ts and the alarm-worker tests.
 */
export const nullRetryAlarm: RetryAlarmPort = {
  arm: () => undefined,
  wait: async () => undefined,
  settle: () => undefined,
};
