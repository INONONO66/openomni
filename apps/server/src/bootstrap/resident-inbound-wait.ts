import type { InboundWaitParams, InboundWaitResult } from "@openomni/coordinator";
import type { DispatchRuntime } from "@openomni/openomni";
import { WorkerRun } from "@openomni/session";
import type { ServerConfig } from "../config";

export type ResidentInboundWaitConfig = {
  readonly serverConfig: ServerConfig;
  readonly dispatchRuntime: Pick<DispatchRuntime, "submit">;
};

// The kernel resident.ask handler returns { output, finishReason, runId }; test
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
  return async ({ workerId, sessionId, runId, payload, workspaceRoot, signal }) => {
    const requestId = crypto.randomUUID();
    const resolvedWorkspace = workspaceRoot ?? config.serverConfig.workspace?.root ?? process.cwd();
    if (signal?.aborted) {
      return { requestId, accepted: false, error: "worker.inbound_wait aborted" };
    }

    const run = runId ? await WorkerRun.get(sessionId, runId) : undefined;
    const mainSessionId = run?.parentSessionId;
    if (!mainSessionId) {
      return {
        requestId,
        accepted: false,
        error: `worker.inbound_wait requires a worker run with parent Resident session: ${runId ?? "unknown"}`,
      };
    }

    if (runId && run?.status === "starting") {
      const starting = await WorkerRun.get(sessionId, runId);
      if (starting?.status === "starting") {
        await WorkerRun.updateStatusIfCurrent(
          sessionId,
          runId,
          { status: "starting", timeUpdated: starting.timeUpdated },
          "running",
        );
      }
    }
    const running = runId ? await WorkerRun.get(sessionId, runId) : undefined;
    if (runId && running?.status === "running") {
      await WorkerRun.updateStatus(sessionId, runId, "waiting_input");
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
      const after = runId ? await WorkerRun.get(sessionId, runId) : undefined;
      if (runId && after?.status === "waiting_input") {
        await WorkerRun.updateStatus(sessionId, runId, "running");
      }
    }
  };
}
