import { CronJob, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";

// #522/#547: a cron job is durable by definition — a scheduled job that does
// not survive process restart is not a cron job. Storage is therefore the
// single canonical source; there is no volatile module-level Map to strand
// jobs registered before init or to leave rows behind on clear(). Every
// read/write/clear goes through the one backing, which fails closed
// (Storage.get() throws) when used before Storage.initialize() — a loud
// boot-order bug, never a silent in-memory fallback. Both consumers run after
// init (CronJobRunner.start at bootstrap; dispatch schedule handlers at
// runtime), and CronJobRunner.tick already treats a throw here as a logged
// Operational.Error rather than a crash.
function cronJobs(): ProtocolStorage.CronJobSubAdapter {
  const adapter = Storage.get().cronJob;
  if (!adapter) throw new Error("Storage adapter does not implement cronJob");
  return adapter;
}

export namespace CronJobRegistry {
  export function register(job: CronJob.Info): string {
    cronJobs().set(job);
    Bus.publish(CronJob.Events.CronJobScheduled, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      jobId: job.id,
      agentName: job.agentName,
      schedule: job.schedule,
    });
    return job.id;
  }

  export function save(job: CronJob.Info): void {
    cronJobs().set(job);
  }

  export function get(jobId: string): CronJob.Info | undefined {
    return cronJobs().get(jobId);
  }

  export function list(): CronJob.Info[] {
    return cronJobs().list();
  }

  export function remove(jobId: string): boolean {
    const deleted = cronJobs().remove(jobId);
    if (deleted) {
      Bus.publish(CronJob.Events.CronJobCancelled, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        jobId,
      });
    }
    return deleted;
  }

  export function clear(): void {
    const adapter = cronJobs();
    for (const job of adapter.list()) adapter.remove(job.id);
  }
}
