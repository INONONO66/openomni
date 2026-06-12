import { CronJob } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";

const jobs = new Map<string, CronJob.Info>();

function adapter() {
  if (Storage.getInitializedDbPath() === null) return undefined;
  return Storage.get().cronJob;
}

export namespace CronJobRegistry {
  export function register(job: CronJob.Info): string {
    jobs.set(job.id, job);
    adapter()?.set(job);
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
    jobs.set(job.id, job);
    adapter()?.set(job);
  }

  export function get(jobId: string): CronJob.Info | undefined {
    const persisted = adapter();
    return persisted ? persisted.get(jobId) : jobs.get(jobId);
  }

  export function list(): CronJob.Info[] {
    const persisted = adapter()?.list();
    return persisted ?? [...jobs.values()];
  }

  export function remove(jobId: string): boolean {
    const deletedFromMemory = jobs.delete(jobId);
    const deletedFromStorage = adapter()?.remove(jobId) ?? false;
    const deleted = deletedFromMemory || deletedFromStorage;
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
    jobs.clear();
  }
}
