import type { AppConnector, Dispatch, Execution, Model } from "@openomni/protocol";
import type {
  ScheduleCreateV1,
  ScheduleProjectionV1,
} from "../execution-runtime/schedule-service.js";
import type { CoordinatorLike } from "../ingress/coordinator-like.js";
import type { ResidentRuntime } from "../resident/runtime.js";

export interface DispatchSchedulerOwner {
  create(schedule: ScheduleCreateV1): Promise<string>;
  cancel(scheduleId: string): Promise<boolean>;
  get(scheduleId: string): Promise<ScheduleProjectionV1 | null>;
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
  readonly defaultModel?: Model.Ref;
}
