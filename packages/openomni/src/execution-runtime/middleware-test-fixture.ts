import type { buildWorkerMiddleware } from "./middleware";

type Registration = ReturnType<typeof buildWorkerMiddleware>[number];

export function findRegistration(
  registrations: ReturnType<typeof buildWorkerMiddleware>,
  name: string,
): Registration | undefined {
  return registrations.find((registration) => registration.name === name);
}

export function invokeTool(registration: Registration | undefined, toolName: string) {
  return registration?.fn({
    timing: "invoke.prepare",
    pointId: "tool.native.pre",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    toolName,
  });
}
