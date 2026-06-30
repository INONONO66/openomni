import { PolicyRegistry } from "@openomni/policy";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
  createCompactionPolicy,
  createIdleNudgePolicy,
  createToolPermissionPolicy,
} from "./builtin";

export { PolicyRegistry } from "@openomni/policy";
export type { PolicyFactory, PolicyRegistryInstance, RuntimeContext } from "@openomni/policy";

export function defaultRegistry(): ReturnType<typeof PolicyRegistry.create> {
  const registry = PolicyRegistry.create();

  registry.register("builtin:budget-reassurance", () => createBudgetReassurancePolicy());
  registry.register("builtin:budget-warning", () => createBudgetWarningPolicy());
  registry.register("builtin:compaction", (config) =>
    createCompactionPolicy(config as Parameters<typeof createCompactionPolicy>[0]),
  );
  registry.register("builtin:idle-nudge", (config) =>
    createIdleNudgePolicy(config as Parameters<typeof createIdleNudgePolicy>[0]),
  );
  registry.register("builtin:tool-permission", (config) =>
    createToolPermissionPolicy(config as Parameters<typeof createToolPermissionPolicy>[0]),
  );

  return registry;
}
