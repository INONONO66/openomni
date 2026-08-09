import type { AppConnector, CronJob, Dispatch, Execution, Model } from "@openomni/protocol";
import type { CoordinatorLike } from "../ingress/coordinator-like.js";
import type { IngressEngine } from "../ingress/engine.js";
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
  /** Ingress engine instance the resident.ask handler executes through (#549). */
  readonly ingress?: Pick<IngressEngine, "ingestInternal">;
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
