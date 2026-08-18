import { Ipc } from "@openomni/protocol";
import type { InjectionQueue } from "@openomni/openomni";
import type { ActiveRunHandle } from "./worker-runner-types";

export namespace WorkerIpcHandlers {
  interface SharedOptions {
    readonly ipcAuthToken: string;
    readonly workerId: string;
  }

  interface CancelRunOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<ActiveRunHandle.ReadableActiveRuns, "get">;
  }

  interface DeliverMessageOptions extends SharedOptions {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<ActiveRunHandle.ReadableActiveRuns, "get">;
    readonly injectionQueue: InjectionQueue.Instance;
  }

  interface ShutdownIdleOptions extends Pick<SharedOptions, "ipcAuthToken"> {
    readonly params: Record<string, unknown> | undefined;
    readonly activeRuns: Pick<ActiveRunHandle.ReadableActiveRuns, "size">;
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

    // #500 B3: the Methods table is the one params contract — fail closed on
    // any frame it rejects instead of best-effort field picking.
    const parsed = Ipc.Methods["coordinator.cancel_run"].params.safeParse(params);
    if (!parsed.success) {
      return { cancelled: false, error: "invalid coordinator.cancel_run params" };
    }

    const { runId, sessionId } = parsed.data;
    const active = activeRuns.get(runId);
    if (!active || active.sessionId !== sessionId) {
      return { cancelled: false, error: `run not active: ${runId}` };
    }

    active.controller.abort(new Error("cancelled by coordinator"));
    return { cancelled: true, runId, sessionId: active.sessionId };
  }

  export function deliverMessage(options: DeliverMessageOptions): DeliverMessageResponse {
    const { params, ipcAuthToken, activeRuns, injectionQueue } = options;

    if (!isAuthorized(params, ipcAuthToken)) {
      return { accepted: false, error: "unauthorized coordinator request" };
    }

    // #500 B3: schema-validated against the Methods table. The missing-trace
    // refusal stays distinct: the run may well be active — the DELIVERY is
    // malformed (a trace-wiring bug upstream).
    const parsed = Ipc.Methods["worker.deliver_message"].params.safeParse(params);
    if (!parsed.success) {
      if (typeof params?.traceId !== "string" || params.traceId.length === 0) {
        return { accepted: false, error: "delivery missing traceId" };
      }
      return { accepted: false, error: "invalid worker.deliver_message params" };
    }

    const { sessionId, runId, message, traceId } = parsed.data;
    if (!sessionId || !runId || !message) {
      return {
        accepted: false,
        error: `run not active for session: ${sessionId || "unknown"}`,
      };
    }

    const active = activeRuns.get(runId);
    if (!active || active.sessionId !== sessionId) {
      return {
        accepted: false,
        error: `run not active for session: ${sessionId}`,
      };
    }

    injectionQueue.enqueue(
      runId,
      { messageId: crypto.randomUUID(), output: message, timestamp: Date.now() },
      traceId,
    );

    return { accepted: true };
  }

  export function canShutdownIdle(options: ShutdownIdleOptions): ShutdownIdleResponse {
    const { params, ipcAuthToken, activeRuns } = options;
    if (!isAuthorized(params, ipcAuthToken)) {
      return { acknowledged: false, error: "unauthorized coordinator request" };
    }
    // #500 B3: fail closed on frames the Methods table rejects.
    if (!Ipc.Methods["worker.shutdown_idle"].params.safeParse(params).success) {
      return { acknowledged: false, error: "invalid worker.shutdown_idle params" };
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

    // #500 B3: schema-validated against the Methods table. `workspaceRoot`
    // is optional on the wire (the supervisor omits it for calls that held no
    // workspace lock) but this handler exists to clear a lock, so a frame
    // without one keeps the historical invalid-params refusal.
    const parsed = Ipc.Methods["worker.tool_call_settled"].params.safeParse(params);
    if (!parsed.success || !parsed.data.workspaceRoot) {
      return { acknowledged: false, error: "invalid worker.tool_call_settled params" };
    }
    const { workspaceRoot, callId } = parsed.data;

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
