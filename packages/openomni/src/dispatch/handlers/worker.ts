import type { Dispatch, Execution, Model } from "@openomni/protocol";
import { Session, WorkItemStore } from "@openomni/session";
import type { CoordinatorLike } from "../../ingress/coordinator-like.js";
import type { DispatchHandler } from "../registry.js";
import { DEFAULT_DISPATCH_MODEL } from "../owners.js";
import { asRecord, extractText } from "./shared.js";

export interface WorkerDispatchHandlerOptions {
  readonly coordinator?: CoordinatorLike;
  readonly defaultModel?: Model.Ref;
}

function requireCoordinator(coordinator: CoordinatorLike | undefined): CoordinatorLike {
  if (!coordinator) throw new Error("dispatch worker handler requires coordinator owner");
  return coordinator;
}

function targetRunId(command: Dispatch.Command): string | undefined {
  return command.target.runId ?? command.target.id;
}

function resolveSessionId(command: Dispatch.Command, model: Model.Ref): string {
  if (command.target.sessionId) return command.target.sessionId;
  const title = `Dispatch worker ${command.action}`;
  const modelInfo = { providerID: model.provider, modelID: model.id };
  const session = command.target.parentSessionId
    ? Session.createChild({
        parentSessionId: command.target.parentSessionId,
        title,
        model: modelInfo,
      })
    : Session.create({ title, model: modelInfo });
  return session.id;
}

function buildRequest(command: Dispatch.Command, model: Model.Ref): Execution.Request {
  const payload = asRecord(command.payload);
  const sessionId = resolveSessionId(command, model);
  return {
    runId: crypto.randomUUID(),
    sessionId,
    mode: "direct",
    prompt: extractText(command.payload),
    model,
    agentName:
      (typeof payload?.agentName === "string" ? payload.agentName : undefined) ??
      command.target.name,
    workspaceRoot: command.workspaceRoot,
    traceId: command.traceId,
  };
}

async function createWorkItem(
  command: Dispatch.Command,
  request: Execution.Request,
): Promise<string> {
  const workItem = await WorkItemStore.create({
    name: `Dispatch worker ${request.agentName ?? "worker"}`,
    sourceMessageId: command.dispatchId,
    sourceChannel: "dispatch",
    intent: command.action,
    goal: request.prompt,
    assigneeId: request.agentName,
    sessionId: request.sessionId,
    context: command.sessionId ? `originSessionId=${command.sessionId}` : undefined,
  });
  await WorkItemStore.start(workItem.hash);
  return workItem.hash;
}

async function reflectCoordinatorResult(
  workItemHash: string,
  result: Execution.Result,
): Promise<void> {
  if (result.status === "cancelled") {
    await WorkItemStore.cancel(workItemHash);
    return;
  }
  if (result.status === "failed" || result.status === "interrupted") {
    await WorkItemStore.fail(workItemHash, result.error ?? result.status);
  }
}

async function markWorkItemFailedAfterDispatchThrow(
  workItemHash: string,
  err: unknown,
): Promise<void> {
  try {
    await WorkItemStore.fail(workItemHash, err instanceof Error ? err.message : String(err));
  } catch {
    return;
  }
}

export function createWorkerDispatchHandlers(
  options: WorkerDispatchHandlerOptions = {},
): Record<"worker.spawn" | "worker.send" | "worker.resume" | "worker.cancel", DispatchHandler> {
  const model = options.defaultModel ?? DEFAULT_DISPATCH_MODEL;
  return {
    async "worker.spawn"(command) {
      const coordinator = requireCoordinator(options.coordinator);
      const request = buildRequest(command, model);
      const workItemHash = await createWorkItem(command, request);
      let result: Execution.Result;
      try {
        result = await coordinator.dispatch(request.sessionId, request);
      } catch (err) {
        await markWorkItemFailedAfterDispatchThrow(workItemHash, err);
        throw err;
      }
      await reflectCoordinatorResult(workItemHash, result);
      return {
        output: { sessionId: request.sessionId, runId: request.runId, workItemHash, result },
      };
    },

    async "worker.send"(command) {
      const coordinator = requireCoordinator(options.coordinator);
      if (!coordinator.deliverMessage) {
        throw new Error("dispatch worker.send requires coordinator.deliverMessage owner");
      }
      const sessionId = command.target.sessionId ?? command.sessionId;
      if (!sessionId) throw new Error("worker.send requires target.sessionId");
      const result = await coordinator.deliverMessage(
        sessionId,
        extractText(command.payload),
        targetRunId(command),
      );
      return { output: { delivered: true, sessionId, runId: targetRunId(command), result } };
    },

    async "worker.resume"(command) {
      const coordinator = requireCoordinator(options.coordinator);
      if (!coordinator.deliverMessage) {
        throw new Error("dispatch worker.resume requires coordinator.deliverMessage owner");
      }
      const sessionId = command.target.sessionId ?? command.sessionId;
      if (!sessionId) throw new Error("worker.resume requires target.sessionId");
      const result = await coordinator.deliverMessage(
        sessionId,
        extractText(command.payload),
        targetRunId(command),
      );
      return { output: { resumed: true, sessionId, runId: targetRunId(command), result } };
    },

    async "worker.cancel"(command) {
      const coordinator = requireCoordinator(options.coordinator);
      if (!coordinator.cancelRun) {
        throw new Error("dispatch worker.cancel requires coordinator.cancelRun owner");
      }
      const runId = targetRunId(command);
      if (!runId) throw new Error("worker.cancel requires target.runId or target.id");
      const result = await coordinator.cancelRun(runId);
      return { output: { cancelled: true, runId, result } };
    },
  };
}
