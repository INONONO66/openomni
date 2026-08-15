import type { InboundWaitParams, InboundWaitResult } from "@openomni/coordinator";
import type { DispatchRuntime } from "@openomni/openomni";
import { WorkItemAttemptRun } from "@openomni/session";
import type { ServerConfig } from "../config";

export type ResidentInboundWaitConfig = {
  readonly serverConfig: ServerConfig;
  readonly dispatchRuntime: Pick<DispatchRuntime, "submit">;
};

// The kernel resident.ask handler returns { output, finishReason }; test
// doubles may return the answer as a bare string.
function residentAskOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "output" in output) {
    const nested = (output as { output?: unknown }).output;
    if (typeof nested === "string") return nested;
  }
  return "";
}

export function createResidentInboundWaitHandler(
  config: ResidentInboundWaitConfig,
): (params: InboundWaitParams) => Promise<InboundWaitResult> {
  return async ({ workerId, traceId, sessionId, runId, payload, workspaceRoot, signal }) => {
    const requestId = crypto.randomUUID();
    const resolvedWorkspace = workspaceRoot ?? config.serverConfig.workspace?.root ?? process.cwd();
    if (signal?.aborted) {
      return { requestId, accepted: false, error: "worker.inbound_wait aborted" };
    }

    // #510 D2b — the run view is the WorkItem attempt projection (frozen
    // legacy worker_run_state rows upcast to terminal views, which the
    // acquire below rejects as no longer active). A missing runId, an
    // unknown run, and a run without a parent Resident session are ONE
    // rejection: no runId means no run means no parent.
    const run = runId ? WorkItemAttemptRun.find(sessionId, runId) : undefined;
    const mainSessionId = run?.parentSessionId;
    if (!runId || !mainSessionId) {
      return {
        requestId,
        accepted: false,
        error: `worker.inbound_wait requires a worker run with parent Resident session: ${runId ?? "unknown"}`,
      };
    }

    // Acquire the wait: ONE serialized head CAS on the work stream (the
    // waiting_input blocker fact). A run that is terminal, already waiting,
    // or transitioned concurrently loses the acquire.
    const acquiredWait = await WorkItemAttemptRun.beginWait(sessionId, runId, traceId);
    if (!acquiredWait) {
      return { requestId, accepted: false, error: "worker.inbound_wait run is no longer active" };
    }

    try {
      const dispatchResult = await config.dispatchRuntime.submit(
        {
          action: "resident.ask",
          target: { kind: "resident", sessionId: mainSessionId },
          payload: `Worker ${workerId}${runId ? ` run ${runId}` : ""} asks Resident:\n\n${payload}`,
          wait: true,
          correlation: requestId,
        },
        {
          traceId,
          sessionId,
          ...(runId ? { runId } : {}),
          actorKind: "worker",
          actorId: `${sessionId}:${runId ?? workerId}`,
          agentName: "worker",
          trustTier: "assigned_worker",
          workspaceRoot: resolvedWorkspace,
          ...(signal ? { signal } : {}),
        },
      );
      if (dispatchResult.status !== "completed") {
        return {
          requestId,
          accepted: false,
          error:
            dispatchResult.error ??
            dispatchResult.reason ??
            `worker.inbound_wait dispatch ${dispatchResult.status}`,
        };
      }
      return {
        requestId,
        accepted: true,
        output: residentAskOutput(dispatchResult.output),
      };
    } finally {
      // Release the wait if it is still ours; a run finished mid-wait keeps
      // its terminal record (endWait is a no-op receipt then).
      await WorkItemAttemptRun.endWait(sessionId, runId, traceId);
    }
  };
}
