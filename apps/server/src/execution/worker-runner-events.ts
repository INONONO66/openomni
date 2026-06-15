import { Subagent } from "@openomni/protocol";
import { Bus } from "@openomni/session";

export function publishWorkerRunStarted(input: {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly prompt: string;
}): void {
  Bus.publish(Subagent.Events.WorkerRunStarted, {
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    time: Date.now(),
    payload: { sessionId: input.sessionId, runId: input.runId, title: input.prompt.slice(0, 80) },
  });
}

export function publishWorkerRunSucceeded(input: {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
}): void {
  Bus.publish(Subagent.Events.WorkerRunCompleted, {
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    time: Date.now(),
    payload: { sessionId: input.sessionId, runId: input.runId, status: "succeeded" },
  });
}

export function publishWorkerRunCancelled(input: {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
}): void {
  Bus.publish(Subagent.Events.WorkerSessionCancelled, {
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    time: Date.now(),
    payload: { sessionId: input.sessionId, runId: input.runId },
  });
}

export function publishWorkerRunFailed(input: {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly errorMessage: string;
}): void {
  Bus.publish(Subagent.Events.WorkerRunFailed, {
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    time: Date.now(),
    payload: { sessionId: input.sessionId, runId: input.runId, error: input.errorMessage },
  });
}
