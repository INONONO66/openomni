import type { CronJob } from "@openomni/protocol";

const jobs = new Map<string, CronJob.Info>();

export namespace CronJobRegistry {
  export function register(job: CronJob.Info): string {
    jobs.set(job.id, job);
    return job.id;
  }

  export function list(): CronJob.Info[] {
    return [...jobs.values()];
  }

  export function remove(jobId: string): boolean {
    return jobs.delete(jobId);
  }
}
