import { PolicyEngine, type PolicyEngineInstance } from "@openomni/agent";
import type { Policy } from "@openomni/protocol";
import type { buildWorkerMiddleware } from "./middleware";

type Registration = ReturnType<typeof buildWorkerMiddleware>[number];

const fixtureDescriptor: Policy.Resource.Descriptor = {
  id: "tool:fixture",
  kind: "tool",
  labels: [],
  capabilities: [],
  effects: [],
};

export function findRegistration(
  registrations: ReturnType<typeof buildWorkerMiddleware>,
  name: string,
): Registration | undefined {
  return registrations.find((registration) => registration.name === name);
}

export function invokeTool(registration: Registration | undefined, toolName: string) {
  if (registration === undefined) return undefined;

  const engine = PolicyEngine.create({ audit: false });
  engine.register(registration);
  const context = {
    sessionId: "fixture-session",
    runId: "fixture-run",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    toolId: toolName,
    toolName,
    toolCallId: "fixture-tool-call",
    toolLabels: [],
    toolInput: {},
    resourceDescriptor: { ...fixtureDescriptor, id: `tool:${toolName}` },
  } satisfies Parameters<PolicyEngineInstance["dispatchPoint"]>[1];

  return engine.dispatchPoint("tool.native.pre", context);
}
