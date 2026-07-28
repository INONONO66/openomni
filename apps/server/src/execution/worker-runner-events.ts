type AttemptProcessObservationBase = {
  readonly runId: string;
  readonly sessionId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly workerId: string;
  readonly generation: number;
  readonly time: number;
};

export type AttemptProcessObservation =
  | {
      readonly name: "attempt.started";
      readonly data: AttemptProcessObservationBase;
    }
  | {
      readonly name: "attempt.succeeded";
      readonly data: AttemptProcessObservationBase & { readonly resultRef: string };
    }
  | {
      readonly name: "attempt.failed" | "attempt.cancelled";
      readonly data: AttemptProcessObservationBase & { readonly reason: string };
    };

export interface AttemptObservationIpcServer {
  notify(method: string, params?: Record<string, unknown>): void;
}

export function publishAttemptProcessObservation(input: {
  readonly server: AttemptObservationIpcServer;
  readonly authToken: string;
  readonly observation: AttemptProcessObservation;
}): void {
  input.server.notify("worker.observation", {
    authToken: input.authToken,
    workerId: input.observation.data.workerId,
    generation: input.observation.data.generation,
    sessionId: input.observation.data.sessionId,
    runId: input.observation.data.runId,
    observation: input.observation,
  });
}
