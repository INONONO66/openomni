import {
  createBudgetReassuranceMiddleware,
  createBudgetWarningMiddleware,
  createIdleNudgeMiddleware,
  createToolGuardMiddleware,
} from "@openomni/agent";
import type { AgentBudget, MiddlewareRegistration } from "@openomni/agent";
import type { Guardrail } from "@openomni/protocol";

export interface WorkerMiddlewareConfig {
  permissions?: Guardrail.Permission;
  budget?: AgentBudget;
}

export function buildWorkerMiddleware(config: WorkerMiddlewareConfig): MiddlewareRegistration[] {
  return [
    createToolGuardMiddleware({
      permission: config.permissions ?? { action: "tool.call" },
    }),
    createBudgetReassuranceMiddleware(),
    createBudgetWarningMiddleware(),
    createIdleNudgeMiddleware(),
  ];
}
