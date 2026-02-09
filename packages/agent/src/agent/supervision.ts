/**
 * Policy for supervision behavior
 */
export interface SupervisionPolicy {
  maxRetries: number;
  timeoutMs: number;
}

/**
 * Supervisor interface for managing child process execution
 */
export interface Supervisor {
  start(): void;
  stop(): void;
  retry(): void;
  escalate(): void;
}

/**
 * Status of a child run
 */
export type ChildRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "escalated";

/**
 * Error class for supervision-related errors
 */
export class SupervisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisionError";
  }
}

export interface SupervisorState {
  attempt: number;
  status: ChildRunStatus;
  startTime: number;
  lastError: Error | undefined;
}

export interface SupervisorInstance {
  start(runFn: () => Promise<void>): void;
  stop(): void;
  getState(): SupervisorState;
  onComplete(callback: (status: ChildRunStatus) => void): void;
}

export namespace Supervisor {
  export function create(policy: SupervisionPolicy): SupervisorInstance {
    let attempt = 0;
    let status: ChildRunStatus = "pending";
    let startTime = 0;
    let lastError: Error | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let onCompleteCallback: ((status: ChildRunStatus) => void) | undefined;

    const clearTimeoutIfNeeded = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const finalize = (finalStatus: ChildRunStatus) => {
      status = finalStatus;
      clearTimeoutIfNeeded();
      onCompleteCallback?.(finalStatus);
    };

    const runWithRetries = async (runFn: () => Promise<void>) => {
      while (!stopped) {
        attempt += 1;
        startTime = Date.now();
        status = "running";

        let timeoutPromise: Promise<never> | undefined;
        if (policy.timeoutMs > 0) {
          timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new SupervisionError("Child run timed out"));
            }, policy.timeoutMs);
            timeoutId.unref?.();
          });
        }

        try {
          if (timeoutPromise) {
            await Promise.race([runFn(), timeoutPromise]);
          } else {
            await runFn();
          }
          finalize("succeeded");
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          clearTimeoutIfNeeded();

          if (attempt > policy.maxRetries) {
            finalize("failed");
            return;
          }

          status = "failed";
        }
      }
    };

    return {
      start(runFn) {
        stopped = false;
        attempt = 0;
        status = "pending";
        startTime = 0;
        lastError = undefined;
        void runWithRetries(runFn);
      },
      stop() {
        stopped = true;
        clearTimeoutIfNeeded();
        if (status === "running") {
          finalize("failed");
        }
      },
      getState() {
        return {
          attempt,
          status,
          startTime,
          lastError,
        };
      },
      onComplete(callback) {
        onCompleteCallback = callback;
      },
    };
  }
}

/**
 * Supervisor namespace for managing child run lifecycle with retry and escalation
 */
export namespace Supervisor {
  export interface RunState {
    status: ChildRunStatus;
    attempt: number;
    startTime?: number;
    error?: Error;
  }

  export function createState(): RunState {
    return {
      status: "pending",
      attempt: 0,
    };
  }

  export function shouldRetry(
    state: RunState,
    policy: SupervisionPolicy,
  ): boolean {
    return state.status === "failed" && state.attempt < policy.maxRetries;
  }

  export function shouldEscalate(
    state: RunState,
    policy: SupervisionPolicy,
  ): boolean {
    return state.status === "failed" && state.attempt >= policy.maxRetries;
  }

  export function recordAttempt(state: RunState): RunState {
    return {
      ...state,
      attempt: state.attempt + 1,
      status: "running",
      startTime: Date.now(),
    };
  }

  export function recordSuccess(state: RunState): RunState {
    return {
      ...state,
      status: "succeeded",
    };
  }

  export function recordFailure(state: RunState, error: Error): RunState {
    return {
      ...state,
      status: "failed",
      error,
    };
  }

  export function recordEscalation(state: RunState): RunState {
    return {
      ...state,
      status: "escalated",
    };
  }

  export function checkTimeout(
    state: RunState,
    policy: SupervisionPolicy,
  ): boolean {
    if (!state.startTime || policy.timeoutMs <= 0) {
      return false;
    }
    return Date.now() - state.startTime > policy.timeoutMs;
  }
}
