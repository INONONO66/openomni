import {
  Operational,
  PolicyDecision,
  PolicyEvent,
  ToolExecution,
  type Policy,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { ToolRuntimeContext } from "./types.js";

const TOOL_CALL_ACTION = "tool.call";

export type EventBase = {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly time: number;
};

export type ToolActor = Record<string, unknown>;

export function buildActor(runtime: ToolRuntimeContext | undefined): ToolActor {
  return {
    kind: "agent",
    ...(runtime?.agentName !== undefined && { agentName: runtime.agentName }),
    ...(runtime?.sessionId !== undefined && { sessionId: runtime.sessionId }),
    ...(runtime?.runId !== undefined && { runId: runtime.runId }),
  };
}

export function createEventBase(runtime: ToolRuntimeContext | undefined): EventBase {
  return {
    traceId: crypto.randomUUID(),
    sessionId: runtime?.sessionId ?? "",
    ...(runtime?.runId !== undefined && { runId: runtime.runId }),
    time: Date.now(),
  };
}

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return typeof input;
  }
  const keys = Object.keys(input).sort();
  return keys.length === 0 ? "empty" : keys.join(",");
}

export function publishActionRequested(args: {
  readonly base: EventBase;
  readonly actionId: string;
  readonly actor: ToolActor;
  readonly resource: string;
  readonly input: unknown;
}): void {
  Bus.publish(PolicyEvent.ActionRequested, {
    ...args.base,
    actionId: args.actionId,
    actor: args.actor,
    action: TOOL_CALL_ACTION,
    resource: args.resource,
    context: { inputSummary: summarizeInput(args.input) },
  });
}

export function publishPolicyEvaluated(args: {
  readonly base: EventBase;
  readonly actor: ToolActor;
  readonly resource: string;
  readonly decision: Policy.PolicyDecision;
}): void {
  if (args.decision.verdict === "allow") return;

  Bus.publish(PolicyEvent.Evaluated, {
    ...args.base,
    policyId: args.decision.policyId,
    actor: args.actor,
    action: TOOL_CALL_ACTION,
    resource: args.resource,
    verdict: args.decision.verdict,
    reason: PolicyDecision.reason(args.decision, "runtime policy evaluated"),
  });
}

export function publishActionBlocked(args: {
  readonly base: EventBase;
  readonly actionId: string;
  readonly actor: ToolActor;
  readonly resource: string;
  readonly verdict: Policy.PolicyDecision["verdict"];
  readonly reason: string;
}): void {
  Bus.publish(PolicyEvent.ActionBlocked, {
    ...args.base,
    actionId: args.actionId,
    actor: args.actor,
    action: TOOL_CALL_ACTION,
    resource: args.resource,
    verdict: args.verdict,
    reason: args.reason,
  });
}

export function publishToolStarted(args: {
  readonly base: EventBase;
  readonly actor: ToolActor;
  readonly toolCallId: string;
  readonly toolName: string;
}): void {
  Bus.publish(ToolExecution.Started, {
    ...args.base,
    actor: args.actor,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
  });
}

export function publishToolCompleted(args: {
  readonly base: EventBase;
  readonly actor: ToolActor;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly durationMs: number;
  readonly isError: boolean;
}): void {
  Bus.publish(ToolExecution.Completed, {
    ...args.base,
    actor: args.actor,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    durationMs: args.durationMs,
    isError: args.isError,
  });
}

export function publishToolTimedOut(args: {
  readonly base: EventBase;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly timeoutMs: number;
}): void {
  Bus.publish(ToolExecution.TimedOut, {
    ...args.base,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    timeoutMs: args.timeoutMs,
  });
}

export function publishTimeoutSettlementWarning(args: {
  readonly base: EventBase;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly graceMs: number;
}): void {
  Bus.publish(Operational.Warn, {
    ...args.base,
    component: "executor",
    msg: "timed-out tool did not settle before post-timeout grace elapsed",
    context: {
      toolName: args.toolName,
      toolCallId: args.toolCallId,
      graceMs: args.graceMs,
    },
  });
}
