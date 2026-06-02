import { CronJobRegistry } from "../execution-runtime/cron-job-registry.js";
import { DispatchRegistry } from "./registry.js";
import { DispatchRuntime, type DispatchRuntimeOptions } from "./runtime.js";
import type { DispatchOwners } from "./owners.js";
import { createResidentDispatchHandlers } from "./handlers/resident.js";
import { createScheduleDispatchHandlers } from "./handlers/schedule.js";
import { createWorkerDispatchHandlers } from "./handlers/worker.js";

export interface BuiltInDispatchOptions {
  readonly owners?: DispatchOwners;
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
      defaultModel: owners.defaultModel,
    }),
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

export function createDefaultDispatchRuntime(
  options: DefaultDispatchRuntimeOptions = {},
): DispatchRuntime {
  const runtime = new DispatchRuntime(options);
  registerBuiltInDispatchHandlers(runtime.registry, { owners: options.owners });
  return runtime;
}
