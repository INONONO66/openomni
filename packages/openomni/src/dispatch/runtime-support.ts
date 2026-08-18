import type { Command, Policy } from "@openomni/protocol";
import type { DispatchHandler } from "./registry.js";

export type DispatchEventPayload = {
  readonly dispatchId: string;
  readonly traceId: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly actor: Command.ActorContext;
  readonly action: string;
  readonly target: Command.Target;
  readonly correlation?: Command.Request["correlation"];
  readonly time: number;
};

export function eventBase(command: Command.Request): DispatchEventPayload {
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

export function policyTraceContext(command: Command.Request) {
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
