import type { CronJob, Model } from "@openomni/protocol";
import type { CoordinatorLike } from "../ingress/coordinator-like.js";
import type { ResidentRuntime } from "../resident/runtime.js";

export interface DispatchSchedulerOwner {
  register(job: CronJob.Info): string;
  remove(jobId: string): boolean;
}

export interface DispatchOwners {
  readonly coordinator?: CoordinatorLike;
  readonly residentRuntime?: Pick<ResidentRuntime, "run">;
  readonly scheduler?: DispatchSchedulerOwner;
  readonly defaultModel?: Model.Ref;
}

export const DEFAULT_DISPATCH_MODEL: Model.Ref = {
  provider: "anthropic",
  id: "claude-3-5-sonnet-20241022",
};
