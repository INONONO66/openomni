import { CronJob } from "@openomni/protocol";
import { Bus } from "@openomni/session";

const jobs = new Map<string, CronJob.Info>();

export namespace CronJobRegistry {
  export function register(job: CronJob.Info): string {
    jobs.set(job.id, job);
    Bus.publish(CronJob.Events.CronJobScheduled, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      jobId: job.id,
      agentName: job.agentName,
      schedule: job.schedule,
    });
    return job.id;
  }

  export function list(): CronJob.Info[] {
    return [...jobs.values()];
  }

  export function remove(jobId: string): boolean {
    const deleted = jobs.delete(jobId);
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
