import { createIdleNudgePolicy, createToolPermissionPolicy } from "@openomni/agent";
import type { PolicyRegistration } from "@openomni/agent";
import type { Policy } from "@openomni/protocol";

export interface WorkerMiddlewareConfig {
  permissions?: Policy.Permission;
}

export function buildWorkerMiddleware(config: WorkerMiddlewareConfig): PolicyRegistration[] {
  return [
    createToolPermissionPolicy({
      permission: config.permissions ?? { action: "tool.call" },
    }),
    createIdleNudgePolicy(),
  ];
}
