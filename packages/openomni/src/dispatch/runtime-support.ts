import type { Dispatch as DispatchProtocol, Policy } from "@openomni/protocol";
import type { DispatchHandler } from "./registry.js";

export type DispatchEventPayload = {
  readonly dispatchId: string;
  readonly traceId: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly actor: DispatchProtocol.ActorContext;
  readonly action: string;
  readonly target: DispatchProtocol.Target;
  readonly correlation?: DispatchProtocol.Command["correlation"];
  readonly time: number;
};

export function eventBase(command: DispatchProtocol.Command): DispatchEventPayload {
  return {
    dispatchId: command.dispatchId,
    traceId: command.traceId,
    ...(command.sessionId ? { sessionId: command.sessionId } : {}),
    ...(command.runId ? { runId: command.runId } : {}),
    actor: command.actor,
    action: command.action,
    target: command.target,
    ...(command.correlation ? { correlation: command.correlation } : {}),
    time: Date.now(),
  };
}

export function resourceDescriptor(action: string): Policy.Resource.Descriptor {
  return {
    id: `dispatch:${action}`,
    kind: "dispatch",
    labels: ["dispatch", `dispatch.action.${action}`],
    capabilities: ["route"],
    effects: ["cross-session"],
    source: { type: "runtime" },
  };
}

export function policyTraceContext(command: DispatchProtocol.Command) {
  return {
    traceId: command.traceId,
    ...(command.sessionId ? { sessionId: command.sessionId } : {}),
    ...(command.runId ? { runId: command.runId } : {}),
  };
}

export function normalizeHandlerOutput(value: Awaited<ReturnType<DispatchHandler>>): unknown {
  if (value && typeof value === "object" && "output" in value) return value.output;
  return value;
}
