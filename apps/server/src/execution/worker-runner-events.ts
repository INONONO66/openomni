import { WorkerRun } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";

export function publishWorkerRunStarted(input: {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly prompt: string;
}): void {
  Bus.publish(WorkerRun.Events.Started, {
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
  Bus.publish(WorkerRun.Events.Completed, {
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
  Bus.publish(WorkerRun.Events.Cancelled, {
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
  Bus.publish(WorkerRun.Events.Failed, {
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    time: Date.now(),
    payload: { sessionId: input.sessionId, runId: input.runId, error: input.errorMessage },
  });
}
