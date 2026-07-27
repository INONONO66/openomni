import { Bus, BusEvent } from "@openomni/session";
import { z } from "zod";
import type { ChildAgentRuntimeOptions, ChildRecord } from "./types.js";

const lifecyclePayload = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  parentRunId: z.string(),
  prompt: z.string(),
  time: z.number(),
});

export const ChildAgentEvents = {
  Started: BusEvent.define("child_agent.started", lifecyclePayload),
  Completed: BusEvent.define(
    "child_agent.completed",
    lifecyclePayload.extend({
      finishReason: z.string(),
    }),
  ),
  Failed: BusEvent.define(
    "child_agent.failed",
    lifecyclePayload.extend({
      error: z.string(),
    }),
  ),
  Cancelled: BusEvent.define("child_agent.cancelled", lifecyclePayload),
} as const;

type LifecyclePayload = z.infer<typeof lifecyclePayload>;

function basePayload(
  options: ChildAgentRuntimeOptions,
  record: ChildRecord,
): LifecyclePayload | undefined {
  const traceContext = options.traceContext;
  if (!traceContext?.traceId || !traceContext.sessionId || !traceContext.runId) return undefined;
  return {
    traceId: traceContext.traceId,
    sessionId: traceContext.sessionId,
    runId: record.id,
    parentRunId: traceContext.runId,
    prompt: record.prompt,
    time: Date.now(),
  };
}

export function publishChildAgentStarted(
  options: ChildAgentRuntimeOptions,
  record: ChildRecord,
): void {
  const payload = basePayload(options, record);
  if (!payload) return;
  Bus.publish(ChildAgentEvents.Started, payload);
}

export function publishChildAgentCompleted(
  options: ChildAgentRuntimeOptions,
  record: ChildRecord,
): void {
  const payload = basePayload(options, record);
  if (!payload || !record.result) return;
  Bus.publish(ChildAgentEvents.Completed, {
    ...payload,
    finishReason: record.result.finishReason,
  });
}

export function publishChildAgentFailed(
  options: ChildAgentRuntimeOptions,
  record: ChildRecord,
): void {
  const payload = basePayload(options, record);
  if (!payload || !record.error) return;
  Bus.publish(ChildAgentEvents.Failed, {
    ...payload,
    error: "child agent failed",
  });
}

export function publishChildAgentCancelled(
  options: ChildAgentRuntimeOptions,
  record: ChildRecord,
): void {
  const payload = basePayload(options, record);
  if (!payload) return;
  Bus.publish(ChildAgentEvents.Cancelled, payload);
}
