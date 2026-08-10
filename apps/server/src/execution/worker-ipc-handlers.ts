import type { InjectionQueue } from "@openomni/openomni";
import type { WorkerRunState } from "./worker-runner-types";

export namespace WorkerIpcHandlers {
  interface SharedOptions {
    readonly ipcAuthToken: string;
    readonly workerId: string;
  }

  interface CancelRunOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<WorkerRunState.ReadableActiveRuns, "get">;
  }

  interface DeliverMessageOptions extends SharedOptions {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<WorkerRunState.ReadableActiveRuns, "get">;
    readonly injectionQueue: InjectionQueue.Instance;
  }

  interface ShutdownIdleOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<WorkerRunState.ReadableActiveRuns, "size">;
  }

  interface ToolCallSettledOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly clearUnsafe: (workspaceRoot: string, callId: string) => void;
  }

  type CancelRunResponse =
    | {
        readonly cancelled: true;
        readonly runId: string;
        readonly sessionId: string;
      }
    | {
        readonly cancelled: false;
        readonly error: string;
      };

  type DeliverMessageResponse =
    | { readonly accepted: true }
    | {
        readonly accepted: false;
        readonly error: string;
      };

  type ShutdownIdleResponse =
    | { readonly acknowledged: true }
    | {
        readonly acknowledged: false;
        readonly error: string;
      };

  type ToolCallSettledResponse =
    | { readonly acknowledged: true }
    | {
        readonly acknowledged: false;
        readonly error: string;
      };

  export function cancelRun(options: CancelRunOptions): CancelRunResponse {
    const { params, ipcAuthToken, activeRuns } = options;
    if (!isAuthorized(params, ipcAuthToken)) {
      return { cancelled: false, error: "unauthorized coordinator request" };
    }

    const runId = readString(params, "runId");
    const sessionId = readString(params, "sessionId");
    const active = runId ? activeRuns.get(runId) : undefined;
    if (!runId || !active || (sessionId && active.sessionId !== sessionId)) {
      return { cancelled: false, error: `run not active: ${runId ?? "unknown"}` };
    }

    active.controller.abort(new Error("cancelled by coordinator"));
    return { cancelled: true, runId, sessionId: active.sessionId };
  }

  export function deliverMessage(options: DeliverMessageOptions): DeliverMessageResponse {
    const { params, ipcAuthToken, activeRuns, injectionQueue } = options;

    if (!isAuthorized(params, ipcAuthToken)) {
      return { accepted: false, error: "unauthorized coordinator request" };
    }

    const sessionId = readString(params, "sessionId");
    const runId = readString(params, "runId");
    const message = readString(params, "message");

    if (!sessionId || !runId || !message) {
      return {
        accepted: false,
        error: `run not active for session: ${sessionId ?? "unknown"}`,
      };
    }

    const active = activeRuns.get(runId);
    if (!active || active.sessionId !== sessionId) {
      return {
        accepted: false,
        error: `run not active for session: ${sessionId}`,
      };
    }

    injectionQueue.enqueue(runId, {
      messageId: crypto.randomUUID(),
      output: message,
      timestamp: Date.now(),
    });

    return { accepted: true };
  }

  export function canShutdownIdle(options: ShutdownIdleOptions): ShutdownIdleResponse {
    const { params, ipcAuthToken, activeRuns } = options;
    if (!isAuthorized(params, ipcAuthToken)) {
      return { acknowledged: false, error: "unauthorized coordinator request" };
    }
    if (activeRuns.size > 0) {
      return { acknowledged: false, error: "worker is busy" };
    }
    return { acknowledged: true };
  }

  export function toolCallSettled(options: ToolCallSettledOptions): ToolCallSettledResponse {
    const { params, ipcAuthToken, clearUnsafe } = options;
    if (!isAuthorized(params, ipcAuthToken)) {
      return { acknowledged: false, error: "unauthorized coordinator request" };
    }

    const workspaceRoot = readString(params, "workspaceRoot");
    const callId = readString(params, "callId");
    if (!workspaceRoot || !callId) {
      return { acknowledged: false, error: "invalid worker.tool_call_settled params" };
    }

    try {
      clearUnsafe(workspaceRoot, callId);
      return { acknowledged: true };
    } catch (error) {
      return {
        acknowledged: false,
        error:
          error instanceof Error
            ? `failed to clear unsafe marker: ${error.message}`
            : "failed to clear unsafe marker",
      };
    }
  }
}

function isAuthorized(params: Record<string, unknown> | undefined, ipcAuthToken: string): boolean {
  return params?.authToken === ipcAuthToken;
}

function readString(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" ? value : undefined;
}
