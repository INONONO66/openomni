import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { ScheduleService, ScheduleFire, ScheduleProjectionV1 } from "./schedule-service.js";

const DEFAULT_INTERVAL_MS = 30_000;

export type FireSchedule = (schedule: ScheduleProjectionV1, fire: ScheduleFire) => Promise<void>;

interface TickOptions {
  readonly service: ScheduleService;
  readonly nowMs?: () => number;
  readonly fire?: FireSchedule;
}

interface StartOptions extends TickOptions {
  readonly intervalMs?: number;
}

interface CronJobRunnerHandle {
  stop(): void;
}

async function missingFireJob(): Promise<void> {
  throw new Error("CronJobRunner requires a fire(schedule) implementation");
}

function publishError(msg: string, context: Readonly<Record<string, string>>): void {
  Bus.publish(Operational.Error, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "cron",
    msg,
    context,
  });
}

export namespace CronJobRunner {
  export async function tick(options: TickOptions): Promise<void> {
    const now = options.nowMs?.() ?? Date.now();
    const fire = options.fire ?? missingFireJob;
    let schedules: readonly ScheduleProjectionV1[];
    try {
      schedules = await options.service.scanDue(now);
    } catch (error) {
      publishError("cron schedule scan failed", {
        err: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const schedule of schedules) {
      if (
        schedule.status === "active" &&
        schedule.pendingFireRef === undefined &&
        schedule.settledFireRef !== undefined &&
        schedule.nextFireAtDbMs === null
      ) {
        try {
          await options.service.advance(schedule, now);
        } catch (error) {
          publishError("cron schedule recovery advance failed", {
            scheduleId: schedule.scheduleId,
            err: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      let recorded: ScheduleFire | null;
      try {
        recorded = await options.service.recordFire(schedule, now);
      } catch (error) {
        publishError("cron fire record failed", {
          scheduleId: schedule.scheduleId,
          err: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (recorded === null) continue;

      try {
        await fire(recorded.schedule, recorded);
      } catch (error) {
        // An exception is not a definite delivery failure. The durable fire remains pending for
        // reconciliation rather than being acknowledged or advanced speculatively.
        publishError("cron job delivery outcome unknown", {
          scheduleId: recorded.schedule.scheduleId,
          fireRef: recorded.fireRef,
          err: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      try {
        const settled = await options.service.settle(recorded, "delivered", now);
        await options.service.advance(settled, now);
      } catch (error) {
        publishError("cron job settlement failed", {
          scheduleId: recorded.schedule.scheduleId,
          fireRef: recorded.fireRef,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  export function start(options: StartOptions): CronJobRunnerHandle {
    let running = false;
    let stopped = false;
    const run = async (): Promise<undefined> => {
      if (running || stopped) return undefined;
      running = true;
      try {
        await tick(options);
      } finally {
        running = false;
      }
      return undefined;
    };
    void run();
    const timer = setInterval(() => {
      void run();
    }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}
