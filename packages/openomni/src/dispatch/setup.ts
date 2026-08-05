import { PolicyEngine } from "@openomni/policy";
import { CronJobRegistry } from "../execution-runtime/cron-job-registry.js";
import type { ReadBackExecutor } from "../evidence/read-back-executor.js";
import type { PolicyResolverInstance } from "../policy/index.js";
import type { CompletionStakesResolver } from "../work-item/completion-admission-authority.js";
import {
  createWorkItemCompletionGateway,
  type WorkItemCompletionGateway,
} from "../work-item/completion-gateway.js";
import type { DispatchRegistry } from "./registry.js";
import { DispatchRuntime, type DispatchRuntimeOptions } from "./runtime.js";
import type { DispatchOwners } from "./owners.js";
import { createDeviceDispatchHandlers } from "./handlers/device.js";
import { createOutboundDispatchHandlers } from "./handlers/outbound.js";
import { createResidentDispatchHandlers } from "./handlers/resident.js";
import { createScheduleDispatchHandlers } from "./handlers/schedule.js";
import type {
  CompletionPolicyEngine,
  WorkerCompletionOptions,
} from "./handlers/worker-completion.js";
import { createWorkerDispatchHandlers } from "./handlers/worker.js";

export interface BuiltInDispatchOptions {
  readonly owners?: DispatchOwners;
  readonly readBack?: ReadBackExecutor.Options;
  readonly readBackEnvelopeTimeoutMs?: number;
  readonly readBackRecorder?: WorkerCompletionOptions["readBackRecorder"];
  readonly now?: WorkerCompletionOptions["now"];
  readonly completionPolicyEngine?: CompletionPolicyEngine;
  readonly completionStakesResolver?: CompletionStakesResolver;
  /** Gate-side task policy stamping rules (#462 §7); defaults to the built-in required plan. */
  readonly policyResolver?: PolicyResolverInstance;
}

export function registerBuiltInDispatchHandlers(
  registry: DispatchRegistry,
  options: BuiltInDispatchOptions = {},
): DispatchRegistry {
  const owners = options.owners ?? {};
  const scheduler = owners.scheduler ?? CronJobRegistry;
  const handlers = {
    ...createResidentDispatchHandlers({
      residentRuntime: owners.residentRuntime,
      defaultModel: owners.defaultModel,
    }),
    ...createWorkerDispatchHandlers({
      coordinator: owners.coordinator,
      connectorEndpointDriver: owners.connectorEndpointDriver,
      defaultModel: owners.defaultModel,
      completionPolicyEngine: options.completionPolicyEngine,
      stakesResolver: options.completionStakesResolver,
      readBack: options.readBack,
      readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
      readBackRecorder: options.readBackRecorder,
      now: options.now,
      policyResolver: options.policyResolver,
    }),
    ...createOutboundDispatchHandlers({ outbound: owners.outbound }),
    ...createDeviceDispatchHandlers({ device: owners.device }),
    ...createScheduleDispatchHandlers({ scheduler }),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    registry.register(action, handler);
  }
  return registry;
}

export interface DefaultDispatchRuntimeOptions
  extends DispatchRuntimeOptions,
    BuiltInDispatchOptions {}

export type DefaultDispatchRuntime = DispatchRuntime &
  Readonly<{
    recoverRecordedWorkItemCompletions: WorkItemCompletionGateway["recoverRecordedCompletions"];
  }>;

export function createDefaultDispatchRuntime(
  options: DefaultDispatchRuntimeOptions = {},
): DefaultDispatchRuntime {
  const completionPolicyEngine = options.completionPolicyEngine ?? PolicyEngine.create();
  const completionGateway = createWorkItemCompletionGateway({
    policyEngine: completionPolicyEngine,
    ...(options.completionStakesResolver === undefined
      ? {}
      : { stakesResolver: options.completionStakesResolver }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const runtime = new DispatchRuntime(options);
  registerBuiltInDispatchHandlers(runtime.registry, {
    owners: options.owners,
    readBack: options.readBack,
    readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
    readBackRecorder: options.readBackRecorder,
    now: options.now,
    completionPolicyEngine,
    completionStakesResolver: options.completionStakesResolver,
    policyResolver: options.policyResolver,
  });
  return Object.assign(runtime, {
    recoverRecordedWorkItemCompletions: completionGateway.recoverRecordedCompletions,
  });
}
