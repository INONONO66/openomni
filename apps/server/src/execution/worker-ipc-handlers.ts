import type { InjectionQueue } from "@openomni/openomni";
import { z } from "zod";
import type { WorkerRunState } from "./worker-run-state";

export namespace WorkerIpcHandlers {
  export interface SharedOptions {
    readonly ipcAuthToken: string;
    readonly workerId: string;
  }

  export interface CancelRunOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<WorkerRunState.ReadableActiveRuns, "get">;
  }

  export interface DeliverMessageOptions extends SharedOptions {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<WorkerRunState.ReadableActiveRuns, "get">;
    readonly injectionQueue: InjectionQueue.Instance;
  }

  export interface ShutdownIdleOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<WorkerRunState.ReadableActiveRuns, "size">;
  }

  export interface ToolCallSettledOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly clearUnsafe: (workspaceRoot: string, callId: string) => void;
  }

  export const CancelRunResponse = z.discriminatedUnion("cancelled", [
    z.object({
      cancelled: z.literal(true),
      runId: z.string(),
      sessionId: z.string(),
    }),
    z.object({
      cancelled: z.literal(false),
      error: z.string(),
    }),
  ]);
  export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

  export const DeliverMessageResponse = z.discriminatedUnion("accepted", [
    z.object({ accepted: z.literal(true) }),
    z.object({
      accepted: z.literal(false),
      error: z.string(),
    }),
  ]);
  export type DeliverMessageResponse = z.infer<typeof DeliverMessageResponse>;

  export const ShutdownIdleResponse = z.discriminatedUnion("acknowledged", [
    z.object({ acknowledged: z.literal(true) }),
    z.object({
      acknowledged: z.literal(false),
      error: z.string(),
    }),
  ]);
  export type ShutdownIdleResponse = z.infer<typeof ShutdownIdleResponse>;

  export const ToolCallSettledResponse = z.discriminatedUnion("acknowledged", [
    z.object({ acknowledged: z.literal(true) }),
    z.object({
      acknowledged: z.literal(false),
      error: z.string(),
    }),
  ]);
  export type ToolCallSettledResponse = z.infer<typeof ToolCallSettledResponse>;

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
