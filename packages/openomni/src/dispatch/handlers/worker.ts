import type { Dispatch, Execution, Model } from "@openomni/protocol";
import { Session, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import type { CoordinatorLike } from "../../ingress/coordinator-like.js";
import type { DispatchHandler } from "../registry.js";
import { DEFAULT_DISPATCH_MODEL } from "../owners.js";
import { extractText } from "./shared.js";

export interface WorkerDispatchHandlerOptions {
  readonly coordinator?: CoordinatorLike;
  readonly defaultModel?: Model.Ref;
}

const AcceptanceCriterion = z.string().trim().min(1);
const WorkerSpawnPayload = z
  .object({
    text: z.string().trim().min(1).optional(),
    prompt: z.string().trim().min(1).optional(),
    acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
    constraints: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine((payload) => payload.text !== undefined || payload.prompt !== undefined, {
    message: "worker.spawn requires text or prompt",
  });

type ParsedWorkerSpawnPayload = {
  readonly prompt: string;
  readonly acceptanceCriteria: string[];
  readonly constraints?: string[];
};

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

function resolveWorkerAgentName(target: Dispatch.Target): string | undefined {
  return target.id ?? target.name;
}

function parseWorkerSpawnPayload(payload: unknown): ParsedWorkerSpawnPayload {
  const parsed = WorkerSpawnPayload.safeParse(payload);
  if (!parsed.success) {
    const payloadRecord = payload && typeof payload === "object" ? payload : undefined;
    if (!payloadRecord || !("acceptanceCriteria" in payloadRecord)) {
      throw new Error("worker.spawn requires at least one acceptance criterion");
    }
    const fields = parsed.error.issues.flatMap((issue) => issue.path);
    if (fields.includes("acceptanceCriteria")) {
      throw new Error("worker.spawn requires at least one acceptance criterion");
    }
    if (parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")) {
      throw new Error("worker.spawn payload contains unsupported fields");
    }
    throw new Error("worker.spawn requires text or prompt");
  }

  return {
    prompt: parsed.data.text ?? parsed.data.prompt ?? "",
    acceptanceCriteria: parsed.data.acceptanceCriteria,
    ...(parsed.data.constraints ? { constraints: parsed.data.constraints } : {}),
  };
}

function buildRequest(
  command: Dispatch.Command,
  model: Model.Ref,
  payload: ParsedWorkerSpawnPayload,
): Execution.Request {
  const sessionId = resolveSessionId(command, model);
  return {
    runId: crypto.randomUUID(),
    sessionId,
    mode: "direct",
    prompt: payload.prompt,
    model,
    agentName: resolveWorkerAgentName(command.target),
    workspaceRoot: command.workspaceRoot,
    traceId: command.traceId,
  };
}

async function createWorkItem(
  command: Dispatch.Command,
  request: Execution.Request,
  payload: ParsedWorkerSpawnPayload,
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
    constraints: payload.constraints,
    acceptanceCriteria: payload.acceptanceCriteria,
  });
  await WorkItemStore.start(workItem.hash);
  return workItem.hash;
}

async function reflectCoordinatorResult(
  workItemHash: string,
  result: Execution.Result,
): Promise<void> {
  if (result.status === "cancelled") {
    await ignoreWorkItemReflectionFailure(() => WorkItemStore.cancel(workItemHash));
    return;
  }
  if (result.status === "failed" || result.status === "interrupted") {
    await ignoreWorkItemReflectionFailure(() =>
      WorkItemStore.fail(workItemHash, result.error ?? result.status),
    );
  }
}

async function ignoreWorkItemReflectionFailure(reflect: () => Promise<unknown>): Promise<void> {
  try {
    await reflect();
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
      const payload = parseWorkerSpawnPayload(command.payload);
      const request = buildRequest(command, model, payload);
      const workItemHash = await createWorkItem(command, request, payload);
      let result: Execution.Result;
      try {
        result = await coordinator.dispatch(request.sessionId, request);
      } catch (err) {
        await ignoreWorkItemReflectionFailure(() =>
          WorkItemStore.fail(workItemHash, err instanceof Error ? err.message : String(err)),
        );
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
