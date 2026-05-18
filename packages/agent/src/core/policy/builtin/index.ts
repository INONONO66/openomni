export {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
  budgetReassuranceFactory,
  budgetWarningFactory,
} from "./budget";
export { createCompactionPolicy, compactionFactory } from "./compaction";
export { createIdleNudgePolicy, idleNudgeFactory } from "./idle-nudge";
export type { IdleNudgeConfig } from "./idle-nudge";
export { createToolPermissionPolicy, toolPermissionFactory } from "./tool-guard";
export type { ToolPermissionPolicyConfig } from "./tool-guard";

import type { PolicyFactory, PolicyRegistry } from "../types";
import { budgetReassuranceFactory, budgetWarningFactory } from "./budget";
import { compactionFactory } from "./compaction";
import { idleNudgeFactory } from "./idle-nudge";
import { toolPermissionFactory } from "./tool-guard";

export const builtinFactories: readonly PolicyFactory[] = [
  budgetReassuranceFactory,
  budgetWarningFactory,
  compactionFactory,
  idleNudgeFactory,
  toolPermissionFactory,
];

export function registerBuiltins(registry: PolicyRegistry): void {
  for (const factory of builtinFactories) {
    registry.register(factory.id, (config, runtime) => factory.create(config, runtime));
  }
}
