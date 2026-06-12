import { WorkItem, type Dispatch, type Execution, type Model } from "@openomni/protocol";
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
const WORKER_SPAWN_TEXT_OR_PROMPT_MESSAGE = "worker.spawn requires text or prompt";
const WorkerSpawnPayload = z
  .object({
    text: z.string().trim().min(1).optional(),
    prompt: z.string().trim().min(1).optional(),
    acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
    constraints: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine((payload) => payload.text !== undefined || payload.prompt !== undefined, {
    message: WORKER_SPAWN_TEXT_OR_PROMPT_MESSAGE,
    path: ["text"],
  })
  .transform((payload) => ({
    prompt: payload.text ?? payload.prompt ?? "",
    acceptanceCriteria: payload.acceptanceCriteria,
    ...(payload.constraints ? { constraints: payload.constraints } : {}),
  }));

const CompletionEnvelope = z.object({
  completionReport: WorkItem.CompletionReport,
});

type WorkerSpawnPayloadInput = z.input<typeof WorkerSpawnPayload>;
type ParsedWorkerSpawnPayload = z.infer<typeof WorkerSpawnPayload>;
type WorkItemStatus = ReturnType<typeof WorkItem.deriveStatus>;
type CompletionReflection = {
  readonly workItemStatus?: WorkItemStatus;
  readonly completionBlocked: boolean;
  readonly completionBlocker?: string;
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

function workerSpawnPayloadErrorMessage(error: z.ZodError<WorkerSpawnPayloadInput>): string {
  if (error.issues.some((issue) => issue.code === "unrecognized_keys")) {
    return "worker.spawn payload contains unsupported fields";
  }

  const fields = new Set(error.issues.flatMap((issue) => issue.path.map(String)));
  if (fields.has("acceptanceCriteria")) {
    return "worker.spawn requires at least one acceptance criterion";
  }
  if (fields.has("constraints")) {
    return "worker.spawn constraints must be non-empty strings";
  }
  if (fields.has("text") || fields.has("prompt")) {
    return WORKER_SPAWN_TEXT_OR_PROMPT_MESSAGE;
  }

  return "worker.spawn payload is invalid";
}

function parseWorkerSpawnPayload(payload: unknown): ParsedWorkerSpawnPayload {
  const parsed = WorkerSpawnPayload.safeParse(payload);
  if (!parsed.success) {
    const payloadRecord = payload && typeof payload === "object" ? payload : undefined;
    if (!payloadRecord || !("acceptanceCriteria" in payloadRecord)) {
      throw new Error("worker.spawn requires at least one acceptance criterion");
    }
    throw new Error(workerSpawnPayloadErrorMessage(parsed.error));
  }

  return parsed.data;
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
    executorKind: "internal_chat_agent",
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
): Promise<CompletionReflection> {
  if (result.status === "succeeded") {
    const completionReport = parseCompletionReport(result);
    if (!completionReport) {
      return blockCompletion(workItemHash, "completion report is required");
    }
    try {
      await WorkItemStore.complete(workItemHash, completionReport);
      return completionReflection(workItemHash, false);
    } catch (err) {
      return blockCompletion(workItemHash, err instanceof Error ? err.message : String(err));
    }
  }
  if (result.status === "cancelled") {
    await ignoreWorkItemReflectionFailure(() => WorkItemStore.cancel(workItemHash));
    return completionReflection(workItemHash, false);
  }
  if (result.status === "failed" || result.status === "interrupted") {
    await ignoreWorkItemReflectionFailure(() =>
      WorkItemStore.fail(workItemHash, result.error ?? result.status),
    );
  }
  return completionReflection(workItemHash, false);
}

function parseCompletionReport(result: Execution.Result): WorkItem.CompletionReport | undefined {
  if (!result.output) return undefined;
  const parsedJson = parseJson(result.output);
  if (!parsedJson.ok) return undefined;
  const parsed = CompletionEnvelope.safeParse(parsedJson.value);
  return parsed.success ? parsed.data.completionReport : undefined;
}

function parseJson(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

async function blockCompletion(
  workItemHash: string,
  description: string,
): Promise<CompletionReflection> {
  await ignoreWorkItemReflectionFailure(() =>
    WorkItemStore.addBlocker(workItemHash, {
      kind: "error",
      description,
    }),
  );
  return completionReflection(workItemHash, true, description);
}

function completionReflection(
  workItemHash: string,
  completionBlocked: boolean,
  completionBlocker?: string,
): CompletionReflection {
  const workItem = WorkItemStore.get(workItemHash);
  return {
    ...(workItem ? { workItemStatus: WorkItem.deriveStatus(workItem) } : {}),
    completionBlocked,
    ...(completionBlocker ? { completionBlocker } : {}),
  };
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
      const reflection = await reflectCoordinatorResult(workItemHash, result);
      return {
        output: {
          sessionId: request.sessionId,
          runId: request.runId,
          workItemHash,
          result,
          reflection,
        },
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
