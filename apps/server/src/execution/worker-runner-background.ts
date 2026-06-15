import {
  type BackgroundManager,
  buildWorkerChildRuntimeConfig,
  buildWorkerMiddleware,
  type createWorkerSubagentRuntime,
} from "@openomni/openomni";
import type { Execution } from "@openomni/protocol";

export function buildDelegationAdmissionMiddleware(
  request: Execution.Request,
): ReturnType<typeof buildWorkerMiddleware> | undefined {
  if (!request.policyPlan) return undefined;
  return buildWorkerMiddleware({
    permissions: request.permissions,
    policyPlan: request.policyPlan,
    includeLifecycle: false,
    includeIdle: false,
  }).map((registration) => ({ ...registration, propagate: true }));
}

export function createScopedBackgroundManager(options: {
  readonly backgroundManager: ReturnType<typeof BackgroundManager.create>;
  readonly workerSubagentConfig: Parameters<typeof createWorkerSubagentRuntime>[0];
}): ReturnType<typeof BackgroundManager.create> {
  const { backgroundManager, workerSubagentConfig } = options;
  return {
    launch(input: Parameters<typeof backgroundManager.launch>[0]) {
      const childRuntime = buildWorkerChildRuntimeConfig(workerSubagentConfig, {
        agentName: input.agentName,
        depth: input.depth ?? 1,
        middleware: input.middleware,
      });
      return backgroundManager.launch({
        ...input,
        systemPrompt: childRuntime.systemPrompt,
        tools: childRuntime.tools,
        toolExecutor: childRuntime.toolExecutor,
        permissions: childRuntime.permissions,
        middleware: childRuntime.middleware,
        childMiddleware: childRuntime.childMiddleware,
      });
    },
    getTask: (taskId) => backgroundManager.getTask(taskId),
    getResult: (taskId) => backgroundManager.getResult(taskId),
    cancel: (taskId) => backgroundManager.cancel(taskId),
    listByParent: (parentSessionId) => backgroundManager.listByParent(parentSessionId),
    cleanup: () => backgroundManager.cleanup(),
    stats: () => backgroundManager.stats(),
    dispose: () => backgroundManager.dispose(),
  };
}
