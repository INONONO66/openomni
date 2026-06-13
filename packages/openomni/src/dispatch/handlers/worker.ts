import type { Dispatch, Execution, Model, WorkItem } from "@openomni/protocol";
import { Session, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import type { CoordinatorLike } from "../../ingress/coordinator-like.js";
import type { LocalCliAgentRuntimeOwner } from "../owners.js";
import type { DispatchHandler } from "../registry.js";
import { DEFAULT_DISPATCH_MODEL } from "../owners.js";
import { handleLocalCliWorkerSpawn, LOCAL_CLI_EXECUTOR_KIND } from "./local-cli-worker.js";
import {
  ignoreWorkItemReflectionFailure,
  reflectCoordinatorResult,
  type WorkerCompletionOptions,
} from "./worker-completion.js";
import { createWorkerSpawnWorkItem, failUnsupportedWorkerExecutor } from "./worker-work-item.js";
import { extractText } from "./shared.js";

export interface WorkerDispatchHandlerOptions extends WorkerCompletionOptions {
  readonly coordinator?: CoordinatorLike;
  readonly localCliAgentRuntime?: LocalCliAgentRuntimeOwner;
  readonly defaultModel?: Model.Ref;
}

const AcceptanceCriterion = z.string().trim().min(1);
const INTERNAL_EXECUTOR_KIND = "internal_chat_agent" satisfies WorkItem.ExecutorKind;
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

type WorkerSpawnPayloadInput = z.input<typeof WorkerSpawnPayload>;
type ParsedWorkerSpawnPayload = z.infer<typeof WorkerSpawnPayload>;

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

function resolveExecutorKind(target: Dispatch.Target): WorkItem.ExecutorKind {
  return target.executorKind ?? INTERNAL_EXECUTOR_KIND;
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

export function createWorkerDispatchHandlers(
  options: WorkerDispatchHandlerOptions = {},
): Record<
  "worker.spawn" | "worker.send" | "worker.resume" | "worker.cancel" | "actor.reply",
  DispatchHandler
> {
  const model = options.defaultModel ?? DEFAULT_DISPATCH_MODEL;
  return {
    async "worker.spawn"(command) {
      const payload = parseWorkerSpawnPayload(command.payload);
      const executorKind = resolveExecutorKind(command.target);
      if (executorKind === LOCAL_CLI_EXECUTOR_KIND) {
        return handleLocalCliWorkerSpawn(command, model, payload, {
          runtime: options.localCliAgentRuntime,
          readBack: options.readBack,
          readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
          readBackRecorder: options.readBackRecorder,
          now: options.now,
        });
      }
      if (executorKind !== INTERNAL_EXECUTOR_KIND) {
        const workItemHash = await createWorkerSpawnWorkItem(
          command,
          {
            prompt: payload.prompt,
            agentName: resolveWorkerAgentName(command.target),
            sessionId: command.target.sessionId,
          },
          payload,
          executorKind,
        );
        return failUnsupportedWorkerExecutor(workItemHash, executorKind);
      }

      const coordinator = requireCoordinator(options.coordinator);
      const request = buildRequest(command, model, payload);
      const workItemHash = await createWorkerSpawnWorkItem(command, request, payload, executorKind);
      let result: Execution.Result;
      try {
        result = await coordinator.dispatch(request.sessionId, request);
      } catch (err) {
        await ignoreWorkItemReflectionFailure(() =>
          WorkItemStore.fail(workItemHash, err instanceof Error ? err.message : String(err)),
        );
        throw err;
      }
      const reflection = await reflectCoordinatorResult(workItemHash, result, {
        readBack: options.readBack,
        readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
      });
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

    async "actor.reply"(command) {
      const coordinator = requireCoordinator(options.coordinator);
      if (!coordinator.deliverMessage) {
        throw new Error("dispatch actor.reply requires coordinator.deliverMessage owner");
      }
      const sessionId = command.target.sessionId ?? command.sessionId;
      if (!sessionId) throw new Error("actor.reply requires target.sessionId");
      const runId = targetRunId(command);
      const result = await coordinator.deliverMessage(
        sessionId,
        extractText(command.payload),
        runId,
      );
      return { output: { delivered: true, sessionId, runId, result } };
    },
  };
}
