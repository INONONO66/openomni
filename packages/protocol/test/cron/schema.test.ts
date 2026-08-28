import { describe, expect, test } from "bun:test";
import { CronJob } from "../../src/index.js";

describe("CronJob schemas", () => {
  test("Info accepts valid data", () => {
    expect(
      CronJob.Info.parse({
        id: "cron-1",
        agentName: "scheduler",
        payload: "do thing",
        schedule: "* * * * *",
        target: { kind: "resident" },
        createdAt: 1000,
      }),
    ).toEqual({
      id: "cron-1",
      agentName: "scheduler",
      payload: "do thing",
      schedule: "* * * * *",
      target: { kind: "resident" },
      createdAt: 1000,
    });
  });

  test("Info accepts target sessionId and nextFireAt", () => {
    expect(
      CronJob.Info.parse({
        id: "cron-2",
        agentName: "scheduler",
        payload: "do thing",
        schedule: "0 * * * *",
        target: { kind: "worker", sessionId: "session-1" },
        createdAt: 1000,
        nextFireAt: 2000,
      }),
    ).toEqual({
      id: "cron-2",
      agentName: "scheduler",
      payload: "do thing",
      schedule: "0 * * * *",
      target: { kind: "worker", sessionId: "session-1" },
      createdAt: 1000,
      nextFireAt: 2000,
    });
  });

  test("Info rejects invalid target kind", () => {
    expect(
      CronJob.Info.safeParse({
        id: "cron-3",
        agentName: "scheduler",
        payload: "do thing",
        schedule: "* * * * *",
        target: { kind: "main" },
        createdAt: 1000,
      }).success,
    ).toBe(false);
  });
});
