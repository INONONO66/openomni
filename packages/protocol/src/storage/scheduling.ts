// This file owns the durable cron scheduling storage contract.
import type { CronJob } from "../cron/index.js";

export type { Storage } from "./namespace.js";

declare module "./namespace.js" {
  namespace Storage {
    export interface CronJobSubAdapter {
      get(id: string): CronJob.Info | undefined;
      set(job: CronJob.Info): void;
      list(): CronJob.Info[];
      remove(id: string): boolean;
    }
  }
}
