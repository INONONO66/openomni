import { Execution, type Dispatch, type Model } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";
import { z } from "zod";
import type { CoordinatorLike } from "../../ingress/coordinator-like.js";
import type { ConnectorEndpointDriverOwner } from "../owners.js";
import type { DispatchHandler } from "../registry.js";
import { DEFAULT_DISPATCH_MODEL } from "../owners.js";
import {
  handleConnectorEndpointWorkerSpawn,
  isConnectorEndpointTarget,
} from "./connector-endpoint-worker.js";
import { projectConnectorCompletion } from "./connector-completion-projector.js";
import {
  ignoreWorkItemReflectionFailure,
  reflectCoordinatorResult,
  type WorkerCompletionOptions,
} from "./worker-completion.js";
import { buildWorkerSpawnRequest, parseWorkerSpawnPayload } from "./worker-spawn-payload.js";
import { createWorkerSpawnWorkItem } from "./worker-work-item.js";
import { extractText } from "./shared.js";

export interface WorkerDispatchHandlerOptions extends WorkerCompletionOptions {
  readonly coordinator?: CoordinatorLike;
  readonly connectorEndpointDriver?: ConnectorEndpointDriverOwner;
  readonly defaultModel?: Model.Ref;
}

const INTERNAL_EXECUTOR_KIND = "internal_chat_agent";
const WorkerCompletePayload = z
  .object({
    workItemHash: z.string().min(1).optional(),
    result: Execution.Result,
  })
  .strict();
type WorkerCompletePayload = z.infer<typeof WorkerCompletePayload>;

function requireCoordinator(coordinator: CoordinatorLike | undefined): CoordinatorLike {
  if (!coordinator) throw new Error("dispatch worker handler requires coordinator owner");
  return coordinator;
}

function targetRunId(command: Dispatch.Command): string | undefined {
  return command.target.runId ?? command.target.id;
}

function parseWorkerCompletePayload(payload: unknown): WorkerCompletePayload {
  const parsed = WorkerCompletePayload.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`worker.complete payload is invalid: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

function resolveCompletedWorkItemHash(
  command: Dispatch.Command,
  payload: WorkerCompletePayload,
): string {
  if (payload.workItemHash !== undefined) return payload.workItemHash;
  const workerRunId = command.target.runId ?? payload.result.runId;
  const workItem = WorkItemStore.list().find((item) => item.workerRunId === workerRunId);
  if (workItem === undefined) {
    throw new Error(`worker.complete could not resolve WorkItem for run ${workerRunId}`);
  }
  return workItem.hash;
}

export function createWorkerDispatchHandlers(
  options: WorkerDispatchHandlerOptions = {},
): Record<
  | "worker.spawn"
  | "worker.complete"
  | "worker.send"
  | "worker.resume"
  | "worker.cancel"
  | "actor.reply",
  DispatchHandler
> {
  const model = options.defaultModel ?? DEFAULT_DISPATCH_MODEL;
  return {
    async "worker.spawn"(command) {
      const payload = parseWorkerSpawnPayload(command.payload);
      if (isConnectorEndpointTarget(command.target)) {
        return handleConnectorEndpointWorkerSpawn(command, model, payload, {
          driver: options.connectorEndpointDriver,
          readBack: options.readBack,
          readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
          readBackRecorder: options.readBackRecorder,
          now: options.now,
        });
      }

      const coordinator = requireCoordinator(options.coordinator);
      const request = buildWorkerSpawnRequest(command, model, payload);
      const workItemHash = await createWorkerSpawnWorkItem(
        command,
        request,
        payload,
        INTERNAL_EXECUTOR_KIND,
      );
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

    async "worker.complete"(command) {
      const payload = parseWorkerCompletePayload(command.payload);
      const workItemHash = resolveCompletedWorkItemHash(command, payload);
      const projection = await projectConnectorCompletion(workItemHash, payload.result, {
        readBack: options.readBack,
        readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
        readBackRecorder: options.readBackRecorder,
        now: options.now,
      });
      return {
        output: {
          workItemHash,
          runId: payload.result.runId,
          sessionId: payload.result.sessionId,
          result: payload.result,
          reflection: projection.reflection,
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
