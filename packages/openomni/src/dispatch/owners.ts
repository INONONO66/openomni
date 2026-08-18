import type { AppConnector, CronJob, Command, Execution, Model } from "@openomni/protocol";
import type { CoordinatorLike } from "../ingress/coordinator-like.js";
import type { BrainEngine } from "../ingress/engine.js";
import type { ResidentRuntime } from "../resident/runtime.js";

export interface DispatchSchedulerOwner {
  /** `traceId` is the dispatching command's trace — schedule lifecycle events inherit it, never mint. */
  register(job: CronJob.Info, traceId: string): string;
  remove(jobId: string, traceId: string): boolean;
}

export interface OutboundDispatchOwnerInput {
  readonly command: Command.Request;
  readonly endpointId: string;
  readonly payload: unknown;
  readonly correlation?: Command.Request["correlation"];
  readonly signal?: AbortSignal;
  readonly wait?: boolean;
  readonly timeoutMs?: number;
}

export interface OutboundDispatchOwner {
  dispatch(input: OutboundDispatchOwnerInput): Promise<unknown> | unknown;
}

export interface DeviceDispatchOwnerInput {
  readonly command: Command.Request;
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
    readonly command: Command.Request;
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
  /** Ingress engine instance the resident.ask handler executes through (#549). */
  readonly ingress?: Pick<BrainEngine, "ingestInternal">;
  readonly scheduler?: DispatchSchedulerOwner;
  readonly defaultModel?: Model.Ref;
}

// The single kernel-side model fallback. Every path that needs a model when
// none was injected (dispatch handlers, ingress session resolution, the
// server resident bridge) must consume this constant — a second literal is
// definition drift (#453 bug 3).
export const DEFAULT_DISPATCH_MODEL: Model.Ref = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
};
