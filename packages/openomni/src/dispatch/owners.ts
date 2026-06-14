import type { AppConnector, CronJob, Dispatch, Execution, Model } from "@openomni/protocol";
import type { CoordinatorLike } from "../ingress/coordinator-like.js";
import type { ResidentRuntime } from "../resident/runtime.js";

export interface DispatchSchedulerOwner {
  register(job: CronJob.Info): string;
  remove(jobId: string): boolean;
}

export interface OutboundDispatchOwnerInput {
  readonly command: Dispatch.Command;
  readonly endpointId: string;
  readonly payload: unknown;
  readonly correlation?: Dispatch.Command["correlation"];
  readonly signal?: AbortSignal;
  readonly wait?: boolean;
  readonly timeoutMs?: number;
}

export interface OutboundDispatchOwner {
  dispatch(input: OutboundDispatchOwnerInput): Promise<unknown> | unknown;
}

export interface DeviceDispatchOwnerInput {
  readonly command: Dispatch.Command;
  readonly deviceId: string;
  readonly payload: unknown;
  readonly signal?: AbortSignal;
  readonly wait?: boolean;
  readonly timeoutMs?: number;
}

export interface DeviceDispatchOwner {
  dispatch(input: DeviceDispatchOwnerInput): Promise<unknown> | unknown;
}

export interface ConnectorEndpointDriverOwner {
  dispatch(input: {
    readonly command: Dispatch.Command;
    readonly executionRequest: Execution.Request;
    readonly installation: AppConnector.Installation;
  }): Promise<Execution.Result>;
}

export interface DispatchOwners {
  readonly coordinator?: CoordinatorLike;
  readonly connectorEndpointDriver?: ConnectorEndpointDriverOwner;
  readonly device?: DeviceDispatchOwner;
  readonly outbound?: OutboundDispatchOwner;
  readonly residentRuntime?: Pick<ResidentRuntime, "run">;
  readonly scheduler?: DispatchSchedulerOwner;
  readonly defaultModel?: Model.Ref;
}

export const DEFAULT_DISPATCH_MODEL: Model.Ref = {
  provider: "anthropic",
  id: "claude-3-5-sonnet-20241022",
};
