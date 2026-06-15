import type { Execution } from "@openomni/protocol";
import { WorkerRun } from "@openomni/session";
import type { HandlerContext } from "./handler-types";
import { extractPrompt } from "./handler-prompt";

type TerminalWorkerRunStatus = "succeeded" | "failed" | "cancelled" | "interrupted";

const terminalWorkerRunStatuses = new Set<string>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export async function createDurableWorkerRun(
  ctx: HandlerContext,
  request: Execution.Request,
): Promise<void> {
  const prompt = extractPrompt(ctx.event.payload);
  await WorkerRun.create(ctx.sessionId, {
    runId: request.runId,
    title: prompt.slice(0, 80) || "Worker run",
    prompt,
    agentName: request.agentName ?? "worker",
    parentSessionId:
      typeof ctx.event.meta?.actor === "object" && ctx.event.meta.actor !== null
        ? String((ctx.event.meta.actor as Record<string, unknown>).sessionId ?? "") || undefined
        : undefined,
  });
  await WorkerRun.updateStatus(ctx.sessionId, request.runId, "starting");
}

async function completeDurableWorkerRun(
  ctx: HandlerContext,
  request: Execution.Request,
  status: TerminalWorkerRunStatus,
  error?: string,
): Promise<void> {
  const existing = await WorkerRun.get(ctx.sessionId, request.runId);
  if (!existing) return;
  if (terminalWorkerRunStatuses.has(existing.status)) return;
  if (existing.status === "starting" && status === "succeeded") {
    await WorkerRun.updateStatus(ctx.sessionId, request.runId, "running");
  }
  await WorkerRun.updateStatus(ctx.sessionId, request.runId, status, {
    endedAt: Date.now(),
    ...(error ? { error } : {}),
  });
}

export async function finishCoordinatorDispatch(
  ctx: HandlerContext,
  request: Execution.Request,
  coordinatorResult: Execution.Result,
): Promise<void> {
  if (coordinatorResult.status !== "succeeded") {
    await completeDurableWorkerRun(ctx, request, coordinatorResult.status, coordinatorResult.error);
    return;
  }
  await completeDurableWorkerRun(ctx, request, "succeeded");
}

export async function markDispatchThrown(
  ctx: HandlerContext,
  request: Execution.Request,
  error: unknown,
): Promise<void> {
  const existing = await WorkerRun.get(ctx.sessionId, request.runId);
  if (!existing || terminalWorkerRunStatuses.has(existing.status)) return;
  const message = error instanceof Error ? error.message : String(error);
  await completeDurableWorkerRun(ctx, request, "interrupted", message);
}
