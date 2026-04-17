import type { AgentBudget, MiddlewareRegistration } from "@openomni/agent";
import type { Guardrail } from "@openomni/protocol";
import { createBudgetReassuranceMiddleware } from "@openomni/agent/src/core/middleware/builtin/budget.js";
import { createBudgetWarningMiddleware } from "@openomni/agent/src/core/middleware/builtin/budget.js";
import { createIdleNudgeMiddleware } from "@openomni/agent/src/core/middleware/builtin/idle-nudge.js";
import { createToolGuardMiddleware } from "@openomni/agent/src/core/middleware/builtin/tool-guard.js";

export interface WorkerMiddlewareConfig {
  permissions?: Guardrail.ToolPermission;
  budget?: AgentBudget;
}

export function buildWorkerMiddleware(config: WorkerMiddlewareConfig): MiddlewareRegistration[] {
  return [
    createToolGuardMiddleware({
      permission: config.permissions ?? {},
    }),
    createBudgetReassuranceMiddleware(),
    createBudgetWarningMiddleware(),
    createIdleNudgeMiddleware(),
  ];
}
