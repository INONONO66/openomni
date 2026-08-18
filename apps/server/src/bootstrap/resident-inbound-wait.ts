import type { InboundWaitParams, InboundWaitResult } from "@openomni/coordinator";
import type { DispatchRuntime } from "@openomni/openomni";
import { Operational } from "@openomni/protocol";
import { WorkItemAttemptRun } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { z } from "zod";
import type { ServerConfig } from "../config";

export type ResidentInboundWaitConfig = {
  readonly serverConfig: ServerConfig;
  readonly dispatchRuntime: Pick<DispatchRuntime, "submit">;
};

// The kernel resident.ask handler returns { output: string, ... }. STRICT
// like dispatch-owners' question bridge (#606 audit): the old lenient shape
// existed for test doubles returning bare strings, and it laundered any
// unexpected shape into an empty "answer" reported as accepted:true — a
// worker asking a question got "" and treated it as the resident's reply.
const residentAskDispatchOutput = z.object({ output: z.string() });

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
          actorKind: "internal_worker",
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
      const parsedOutput = residentAskDispatchOutput.safeParse(dispatchResult.output);
      if (!parsedOutput.success) {
        // Refuse, never launder: the old lenient shape turned any unexpected
        // envelope into an empty "answer" reported accepted:true.
        return {
          requestId,
          accepted: false,
          error: `resident.ask returned an invalid inbound-wait response: ${parsedOutput.error.message}`,
        };
      }
      return {
        requestId,
        accepted: true,
        output: parsedOutput.data.output,
      };
    } finally {
      // Release the wait if it is still ours; a run finished mid-wait keeps
      // its terminal record (endWait is a no-op receipt then). A failed
      // release (e.g. a BUSY store) must not discard the answer the resident
      // already produced — record it and let the blocker age out.
      try {
        await WorkItemAttemptRun.endWait(sessionId, runId, traceId);
      } catch (releaseError) {
        Bus.publish(Operational.Events.Warn, {
          traceId,
          time: Date.now(),
          sessionId,
          component: "server",
          msg: "inbound-wait release failed; answer kept, blocker ages out",
          context: {
            runId,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          },
        });
      }
    }
  };
}
