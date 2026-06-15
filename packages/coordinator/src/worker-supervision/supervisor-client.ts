import type { IpcClient } from "../ipc/client";
import { resolveDispatchTimeoutMs } from "./supervisor-process.js";

export async function dispatchWorkerRun(
  client: IpcClient | null,
  workerId: number,
  authToken: string,
  runId: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!client?.connected) {
    throw new Error(`worker ${workerId} not available`);
  }
  return client.call(
    "coordinator.spawn_run",
    { authToken, runId, ...params },
    resolveDispatchTimeoutMs(params),
  );
}

export async function cancelWorkerRun(
  client: IpcClient | null,
  workerId: number,
  authToken: string,
  runId: string,
  sessionId: string,
): Promise<unknown> {
  if (!client?.connected) {
    return { cancelled: false, error: `worker ${workerId} not available` };
  }
  return client.call("coordinator.cancel_run", { authToken, runId, sessionId }, 5_000);
}

export async function deliverWorkerMessage(
  client: IpcClient | null,
  workerId: number,
  authToken: string,
  sessionId: string,
  message: string,
  runId?: string,
): Promise<unknown> {
  if (!client?.connected) {
    return { accepted: false, error: `worker ${workerId} not available` };
  }
  return client.call(
    "worker.deliver_message",
    { authToken, sessionId, ...(runId ? { runId } : {}), message },
    5_000,
  );
}
