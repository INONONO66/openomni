import { CronJob, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { Cron } from "croner";
import { CronJobRegistry } from "./cron-job-registry.js";

const DEFAULT_INTERVAL_MS = 30_000;

type FireJob = (job: CronJob.Info) => Promise<void>;

function parseInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid cron ${field} value: ${value}`);
  return Number.parseInt(value, 10);
}

function assertInRange(value: number, field: string, min: number, max: number): void {
  if (value < min || value > max) throw new Error(`Cron ${field} value out of range: ${value}`);
}

function addRange(
  values: Set<number>,
  field: string,
  min: number,
  max: number,
  range: string,
  step: number | undefined,
): void {
  const resolvedStep = step ?? 1;
  if (!Number.isInteger(resolvedStep) || resolvedStep <= 0) {
    throw new Error(`Invalid cron ${field} step: ${resolvedStep}`);
  }
  const rangeParts = range === "*" ? [String(min), String(max)] : range.split("-");
  if (rangeParts.length > 2) throw new Error(`Invalid cron ${field} range: ${range}`);
  const [startRaw, endRaw] = rangeParts;
  if (!startRaw || !endRaw) {
    if (step !== undefined) throw new Error(`Invalid cron ${field} step target: ${range}`);
    const value = parseInteger(range, field);
    assertInRange(value, field, min, max);
    values.add(value);
    return;
  }
  const start = parseInteger(startRaw, field);
  const end = parseInteger(endRaw, field);
  assertInRange(start, field, min, max);
  assertInRange(end, field, min, max);
  if (start > end) throw new Error(`Invalid cron ${field} range: ${range}`);
  for (let value = start; value <= end; value += resolvedStep) values.add(value);
}

function normalizeField(source: string, field: string, min: number, max: number): string {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    if (!part) throw new Error(`Invalid cron ${field} field: ${source}`);
    const stepParts = part.split("/");
    if (stepParts.length > 2) throw new Error(`Invalid cron ${field} field: ${source}`);
    const [range, stepRaw] = stepParts;
    if (!range) throw new Error(`Invalid cron ${field} field: ${source}`);
    addRange(values, field, min, max, range, stepRaw ? parseInteger(stepRaw, field) : undefined);
  }
  return [...values].sort((left, right) => left - right).join(",");
}

function normalizeSchedule(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Unsupported cron schedule: ${schedule}`);
  return [
    normalizeField(fields[0] ?? "", "minute", 0, 59),
    normalizeField(fields[1] ?? "", "hour", 0, 23),
    normalizeField(fields[2] ?? "", "day-of-month", 1, 31),
    normalizeField(fields[3] ?? "", "month", 1, 12),
    normalizeField(fields[4] ?? "", "day-of-week", 0, 7),
  ].join(" ");
}

function computeNextFireAt(schedule: string, afterMs: number): number {
  const nextRun = new Cron(normalizeSchedule(schedule), {
    paused: true,
    timezone: "UTC",
    domAndDow: true,
    mode: "5-part",
  }).nextRun(new Date(afterMs));
  if (!nextRun) throw new Error(`Unable to find next cron fire time for schedule: ${schedule}`);
  return nextRun.getTime();
}

function dueAt(job: CronJob.Info): number {
  return job.nextFireAt ?? computeNextFireAt(job.schedule, job.createdAt);
}

async function missingFireJob(): Promise<void> {
  throw new Error("CronJobRunner requires a fire(job) implementation");
}

export namespace CronJobRunner {
  export interface TickOptions {
    readonly nowMs?: () => number;
    readonly fire?: FireJob;
  }

  export interface StartOptions extends TickOptions {
    readonly intervalMs?: number;
  }

  export interface Handle {
    stop(): void;
  }

  export async function tick(options: TickOptions = {}): Promise<void> {
    const now = options.nowMs?.() ?? Date.now();
    const fire = options.fire ?? missingFireJob;
    let jobs: CronJob.Info[];
    try {
      jobs = CronJobRegistry.list();
    } catch (err) {
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "cron",
        msg: "cron job list failed",
        context: { err: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    for (const job of jobs) {
      try {
        const nextFireAt = dueAt(job);
        if (job.nextFireAt === undefined) CronJobRegistry.save({ ...job, nextFireAt });
        if (nextFireAt > now) continue;
        if (!CronJobRegistry.get(job.id)) continue;
        await fire({ ...job, nextFireAt });
        Bus.publish(CronJob.Events.CronJobFired, {
          traceId: crypto.randomUUID(),
          time: now,
          jobId: job.id,
          agentName: job.agentName,
        });
        if (CronJobRegistry.get(job.id)) {
          CronJobRegistry.save({ ...job, nextFireAt: computeNextFireAt(job.schedule, now) });
        }
      } catch (err) {
        Bus.publish(Operational.Error, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "cron",
          msg: "cron job fire failed",
          context: { jobId: job.id, err: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  export function start(options: StartOptions): Handle {
    let running = false;
    let stopped = false;
    const run = async () => {
      if (running || stopped) return;
      running = true;
      try {
        await tick(options);
      } finally {
        running = false;
      }
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
