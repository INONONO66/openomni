import type { ScheduleService } from "../execution-runtime/schedule-service.js";
import type { ToolEffectLedgerPortV1 } from "../execution-runtime/tool/types.js";
import type { WorkerAttemptLifecycleService } from "../ingress/handler-worker-run.js";
import type { WaitKernelService } from "../ingress/wait-correlation.js";
import type { ReadBackExecutor } from "../evidence/read-back-executor.js";
import type { PolicyResolverInstance } from "../policy/index.js";
import type { DispatchRegistry } from "./registry.js";
import { DispatchRuntime, type DispatchRuntimeOptions } from "./runtime.js";
import type { DispatchOwners } from "./owners.js";
import { createDeviceDispatchHandlers } from "./handlers/device.js";
import { createOutboundDispatchHandlers } from "./handlers/outbound.js";
import { createResidentDispatchHandlers } from "./handlers/resident.js";
import { createScheduleDispatchHandlers } from "./handlers/schedule.js";
import { createWorkerDispatchHandlers } from "./handlers/worker.js";
import type { WorkerLedgerService } from "./handlers/worker-work-item.js";

export interface BuiltInDispatchOptions {
  readonly owners: DispatchOwners;
  readonly waitKernel: WaitKernelService;
  readonly effects: ToolEffectLedgerPortV1;
  readonly scheduleService: Pick<ScheduleService, "create" | "cancel">;
  readonly workerAttempts: WorkerAttemptLifecycleService;
  readonly workerLedger: WorkerLedgerService;
  readonly readBack?: ReadBackExecutor.Options;
  readonly readBackEnvelopeTimeoutMs?: number;
  /** Gate-side task policy stamping rules (#462 §7); defaults to the built-in required plan. */
  readonly policyResolver?: PolicyResolverInstance;
}

export function registerBuiltInDispatchHandlers(
  registry: DispatchRegistry,
  options: BuiltInDispatchOptions,
): DispatchRegistry {
  const owners = options.owners;
  const handlers = {
    ...createResidentDispatchHandlers({
      residentRuntime: owners.residentRuntime,
      defaultModel: owners.defaultModel,
      waitKernel: options.waitKernel,
    }),
    ...createWorkerDispatchHandlers({
      coordinator: owners.coordinator,
      connectorEndpointDriver: owners.connectorEndpointDriver,
      defaultModel: owners.defaultModel,
      workerAttempts: options.workerAttempts,
      ledger: options.workerLedger,
      readBack: options.readBack,
      readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
      policyResolver: options.policyResolver,
    }),
    ...createOutboundDispatchHandlers({ outbound: owners.outbound, effects: options.effects }),
    ...createDeviceDispatchHandlers({ device: owners.device, effects: options.effects }),
    ...createScheduleDispatchHandlers({ scheduler: options.scheduleService }),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    registry.register(action, handler);
  }
  return registry;
}

export interface DefaultDispatchRuntimeOptions
  extends DispatchRuntimeOptions,
    BuiltInDispatchOptions {}

export function createDefaultDispatchRuntime(
  options: DefaultDispatchRuntimeOptions,
): DispatchRuntime {
  const runtime = new DispatchRuntime(options);
  registerBuiltInDispatchHandlers(runtime.registry, {
    owners: options.owners,
    waitKernel: options.waitKernel,
    effects: options.effects,
    scheduleService: options.scheduleService,
    workerAttempts: options.workerAttempts,
    workerLedger: options.workerLedger,
    readBack: options.readBack,
    readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
    policyResolver: options.policyResolver,
  });
  return runtime;
}
