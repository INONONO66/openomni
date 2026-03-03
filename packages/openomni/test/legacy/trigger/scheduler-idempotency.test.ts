import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Scheduler, computeTimeBucket } from "../../../src/legacy/trigger/scheduler";
import { Task } from "../../../src/legacy/task/types";
import { IngressEngine } from "../../../src/legacy/ingress/engine";

describe("Scheduler Idempotency — timeBucket-based dedupeKey", () => {
  beforeEach(() => {
    Scheduler.clear();
  });

  afterEach(() => {
    Scheduler.clear();
  });

  describe("computeTimeBucket()", () => {
    describe("cron triggers", () => {
      it("should floor to nearest minute (60000ms)", () => {
        const cronTrigger: Task.TriggerCron = {
          id: "cron-1",
          type: "cron",
          expr: "0 10 * * *",
        };

        // 10:00:01 (10 * 60 * 1000 + 1000)
        const time1 = 10 * 60 * 1000 + 1000;
        const bucket1 = computeTimeBucket(cronTrigger, time1);
        expect(bucket1).toBe(10 * 60 * 1000);

        // 10:00:59 (10 * 60 * 1000 + 59000)
        const time2 = 10 * 60 * 1000 + 59000;
        const bucket2 = computeTimeBucket(cronTrigger, time2);
        expect(bucket2).toBe(10 * 60 * 1000);

        // Both should be in same bucket
        expect(bucket1).toBe(bucket2);
      });

      it("should produce different buckets for different minutes", () => {
        const cronTrigger: Task.TriggerCron = {
          id: "cron-1",
          type: "cron",
          expr: "0 10 * * *",
        };

        // 10:00:30 (600000 + 30000 = 630000)
        const time1 = 10 * 60 * 1000 + 30000;
        const bucket1 = computeTimeBucket(cronTrigger, time1);

        // 11:00:30 (660000 + 30000 = 690000)
        const time2 = 11 * 60 * 1000 + 30000;
        const bucket2 = computeTimeBucket(cronTrigger, time2);

        expect(bucket1).not.toBe(bucket2);
        expect(bucket1).toBe(10 * 60 * 1000);
        expect(bucket2).toBe(11 * 60 * 1000);
      });

      it("should handle minute boundaries correctly", () => {
        const cronTrigger: Task.TriggerCron = {
          id: "cron-1",
          type: "cron",
          expr: "0 10 * * *",
        };

        // Exactly at minute boundary
        const exactMinute = 10 * 60 * 1000;
        const bucket = computeTimeBucket(cronTrigger, exactMinute);
        expect(bucket).toBe(exactMinute);
      });
    });

    describe("interval triggers", () => {
      it("should floor to interval bucket", () => {
        const intervalTrigger: Task.TriggerInterval = {
          id: "interval-1",
          type: "interval",
          ms: 5000, // 5 second interval
        };

        // 7 seconds into cycle (5000 + 2000)
        const time1 = 5000 + 2000;
        const bucket1 = computeTimeBucket(intervalTrigger, time1);
        expect(bucket1).toBe(5000);

        // 9 seconds into cycle (5000 + 4000)
        const time2 = 5000 + 4000;
        const bucket2 = computeTimeBucket(intervalTrigger, time2);
        expect(bucket2).toBe(5000);

        // Both in same bucket
        expect(bucket1).toBe(bucket2);
      });

      it("should produce different buckets for different intervals", () => {
        const intervalTrigger: Task.TriggerInterval = {
          id: "interval-1",
          type: "interval",
          ms: 5000,
        };

        // 4999ms (still in first bucket)
        const time1 = 4999;
        const bucket1 = computeTimeBucket(intervalTrigger, time1);
        expect(bucket1).toBe(0);

        // 5001ms (in second bucket)
        const time2 = 5001;
        const bucket2 = computeTimeBucket(intervalTrigger, time2);
        expect(bucket2).toBe(5000);

        expect(bucket1).not.toBe(bucket2);
      });

      it("should handle large intervals", () => {
        const intervalTrigger: Task.TriggerInterval = {
          id: "interval-1",
          type: "interval",
          ms: 3600000, // 1 hour
        };

        // 30 minutes in
        const time1 = 30 * 60 * 1000;
        const bucket1 = computeTimeBucket(intervalTrigger, time1);
        expect(bucket1).toBe(0);

        // 90 minutes in
        const time2 = 90 * 60 * 1000;
        const bucket2 = computeTimeBucket(intervalTrigger, time2);
        expect(bucket2).toBe(3600000);

        expect(bucket1).not.toBe(bucket2);
      });
    });

    describe("once triggers", () => {
      it("should use exact timestamp (deterministic)", () => {
        const onceTrigger: Task.TriggerOnce = {
          id: "once-1",
          type: "once",
          at: 1000000,
        };

        // Any current time should produce the same bucket
        const bucket1 = computeTimeBucket(onceTrigger, 500000);
        const bucket2 = computeTimeBucket(onceTrigger, 1500000);
        const bucket3 = computeTimeBucket(onceTrigger, 2000000);

        expect(bucket1).toBe(1000000);
        expect(bucket2).toBe(1000000);
        expect(bucket3).toBe(1000000);
      });

      it("should be deterministic across multiple calls", () => {
        const onceTrigger: Task.TriggerOnce = {
          id: "once-1",
          type: "once",
          at: 5000000,
        };

        const buckets = [
          computeTimeBucket(onceTrigger, 1000),
          computeTimeBucket(onceTrigger, 2000),
          computeTimeBucket(onceTrigger, 3000),
        ];

        expect(buckets[0]).toBe(5000000);
        expect(buckets[1]).toBe(5000000);
        expect(buckets[2]).toBe(5000000);
      });
    });
  });

  describe("fire() dedupeKey generation", () => {
    let ingestedEvents: any[] = [];
    let originalDateNow: typeof Date.now;
    let originalIngest: typeof IngressEngine.ingest;

    beforeEach(() => {
      ingestedEvents = [];
      originalDateNow = Date.now;
      // Mock IngressEngine.ingest to capture events
      originalIngest = IngressEngine.ingest;
      (IngressEngine as any).ingest = async (event: any) => {
        ingestedEvents.push(event);
      };
    });

    afterEach(() => {
      // Restore original ingest and Date.now
      IngressEngine.ingest = originalIngest;
      Date.now = originalDateNow;
      ingestedEvents = [];
    });

    it("should generate same dedupeKey for cron fires within same minute", async () => {
      const taskId = "task-1";
      const cronTrigger: Task.TriggerCron = {
        id: "cron-1",
        type: "cron",
        expr: "0 10 * * *",
      };

      const baseTime = 10 * 60 * 1000;

      Date.now = () => baseTime + 5000;
      await Scheduler.fire(taskId, cronTrigger);
      const event1 = ingestedEvents[ingestedEvents.length - 1];

      Date.now = () => baseTime + 45000;
      await Scheduler.fire(taskId, cronTrigger);
      const event2 = ingestedEvents[ingestedEvents.length - 1];

      expect(event1.dedupeKey).toBe(event2.dedupeKey);
      expect(event1.dedupeKey).toMatch(/^sched:task-1:cron-1:\d+$/);
    });

    it("should generate different dedupeKeys for cron fires in different minutes", async () => {
      const taskId = "task-1";
      const cronTrigger: Task.TriggerCron = {
        id: "cron-1",
        type: "cron",
        expr: "0 10 * * *",
      };

      const baseTime = 10 * 60 * 1000;

      Date.now = () => baseTime + 30000;
      await Scheduler.fire(taskId, cronTrigger);
      const event1 = ingestedEvents[ingestedEvents.length - 1];

      Date.now = () => baseTime + 60000 + 30000;
      await Scheduler.fire(taskId, cronTrigger);
      const event2 = ingestedEvents[ingestedEvents.length - 1];

      expect(event1.dedupeKey).not.toBe(event2.dedupeKey);
    });

    it("should generate same dedupeKey for interval fires within same bucket", async () => {
      const taskId = "task-1";
      const intervalTrigger: Task.TriggerInterval = {
        id: "interval-1",
        type: "interval",
        ms: 10000,
      };

      const baseTime = 50000;

      Date.now = () => baseTime + 500;
      await Scheduler.fire(taskId, intervalTrigger);
      const event1 = ingestedEvents[ingestedEvents.length - 1];

      Date.now = () => baseTime + 900;
      await Scheduler.fire(taskId, intervalTrigger);
      const event2 = ingestedEvents[ingestedEvents.length - 1];

      expect(event1.dedupeKey).toBe(event2.dedupeKey);
    });

    it("should generate different dedupeKeys for interval fires in different buckets", async () => {
      const taskId = "task-1";
      const intervalTrigger: Task.TriggerInterval = {
        id: "interval-1",
        type: "interval",
        ms: 10000,
      };

      const baseTime = 50000;

      Date.now = () => baseTime + 900;
      await Scheduler.fire(taskId, intervalTrigger);
      const event1 = ingestedEvents[ingestedEvents.length - 1];

      Date.now = () => baseTime + 10100;
      await Scheduler.fire(taskId, intervalTrigger);
      const event2 = ingestedEvents[ingestedEvents.length - 1];

      expect(event1.dedupeKey).not.toBe(event2.dedupeKey);
    });

    it("should generate same dedupeKey for once trigger (always deterministic)", async () => {
      const taskId = "task-1";
      const onceTrigger: Task.TriggerOnce = {
        id: "once-1",
        type: "once",
        at: 1000000,
      };

      Date.now = () => 500000;
      await Scheduler.fire(taskId, onceTrigger);
      const event1 = ingestedEvents[ingestedEvents.length - 1];

      Date.now = () => 2000000;
      await Scheduler.fire(taskId, onceTrigger);
      const event2 = ingestedEvents[ingestedEvents.length - 1];

      expect(event1.dedupeKey).toBe(event2.dedupeKey);
      expect(event1.dedupeKey).toMatch(/^sched:task-1:once-1:1000000$/);
    });

    it("should include taskId and triggerId in dedupeKey", async () => {
      const taskId = "my-task";
      const cronTrigger: Task.TriggerCron = {
        id: "my-trigger",
        type: "cron",
        expr: "0 10 * * *",
      };

      Date.now = () => 10 * 60 * 1000;
      await Scheduler.fire(taskId, cronTrigger);
      const event = ingestedEvents[ingestedEvents.length - 1];

      expect(event.dedupeKey).toContain("my-task");
      expect(event.dedupeKey).toContain("my-trigger");
    });

    it("should have format: sched:taskId:triggerId:timeBucket", async () => {
      const taskId = "task-1";
      const cronTrigger: Task.TriggerCron = {
        id: "cron-1",
        type: "cron",
        expr: "0 10 * * *",
      };

      Date.now = () => 10 * 60 * 1000 + 30000;
      await Scheduler.fire(taskId, cronTrigger);
      const event = ingestedEvents[ingestedEvents.length - 1];

      const parts = event.dedupeKey.split(":");
      expect(parts.length).toBe(4);
      expect(parts[0]).toBe("sched");
      expect(parts[1]).toBe("task-1");
      expect(parts[2]).toBe("cron-1");
      expect(parts[3]).toMatch(/^\d+$/);
    });
  });
});
