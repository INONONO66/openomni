import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

const DEFAULT_MAX_INBOX_MESSAGES = 100;

export namespace WorkerIpcHandlers {
  export interface ActiveRun {
    readonly sessionId: string;
    readonly controller: AbortController;
    readonly inbox: string[];
  }

  export type ActiveRuns = Pick<Map<string, ActiveRun>, "get" | "entries" | "size">;

  export interface SharedOptions {
    readonly ipcAuthToken: string;
    readonly workerId: string;
    readonly maxInboxMessages?: number;
  }

  export interface CancelRunOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<ActiveRuns, "get">;
  }

  export interface DeliverMessageOptions extends SharedOptions {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<ActiveRuns, "entries">;
  }

  export interface ShutdownIdleOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<ActiveRuns, "size">;
  }

  export type CancelRunResponse = {
    readonly cancelled: boolean;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly error?: string;
  };

  export type DeliverMessageResponse = {
    readonly accepted: boolean;
    readonly error?: string;
  };

  export type ShutdownIdleResponse = {
    readonly acknowledged: boolean;
    readonly error?: string;
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
    const { params, ipcAuthToken, workerId, activeRuns } = options;
    const maxInboxMessages = options.maxInboxMessages ?? DEFAULT_MAX_INBOX_MESSAGES;

    if (!isAuthorized(params, ipcAuthToken)) {
      return { accepted: false, error: "unauthorized coordinator request" };
    }

    const sessionId = readString(params, "sessionId");
    const runId = readString(params, "runId");
    const message = readString(params, "message");
    const matches = sessionId
      ? [...activeRuns.entries()].filter(
          ([activeRunId, run]) =>
            run.sessionId === sessionId && (runId === undefined || activeRunId === runId),
        )
      : [];

    if (!sessionId || !message || matches.length === 0) {
      return {
        accepted: false,
        error: `run not active for session: ${sessionId ?? "unknown"}`,
      };
    }
    if (!runId && matches.length > 1) {
      return {
        accepted: false,
        error: `multiple active runs for session: ${sessionId}`,
      };
    }

    const [activeRunId, run] = matches[0] as [string, ActiveRun];
    if (run.inbox.length >= maxInboxMessages) {
      run.inbox.shift();
    }
    run.inbox.push(message);

    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "live worker message delivered to active worker inbox",
      context: {
        workerId,
        sessionId,
        runId: activeRunId,
        bytes: message.length,
        inboxDepth: run.inbox.length,
      },
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
}

function isAuthorized(params: Record<string, unknown> | undefined, ipcAuthToken: string): boolean {
  return params?.authToken === ipcAuthToken;
}

function readString(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" ? value : undefined;
}
