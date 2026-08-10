import { Execution, type Dispatch, type Model, type WorkItem } from "@openomni/protocol";
import { WorkerRunStateStore, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { VerifierRegistry } from "../../evidence/verifier-registry.js";
import type { CoordinatorLike } from "../../ingress/coordinator-like.js";
import { PolicyResolver, type PolicyResolverInstance } from "../../policy/index.js";
import type { ConnectorEndpointDriverOwner } from "../owners.js";
import type { DispatchHandler } from "../registry.js";
import { DEFAULT_DISPATCH_MODEL } from "../owners.js";
import {
  handleConnectorEndpointWorkerSpawn,
  isConnectorEndpointTarget,
} from "./connector-endpoint-worker.js";
import { projectConnectorCompletion } from "./connector-completion-projector.js";
import { reflectCoordinatorResult, type WorkerCompletionOptions } from "./worker-completion.js";
import { buildWorkerSpawnRequest, parseWorkerSpawnPayload } from "./worker-spawn-payload.js";
import {
  allocateWorkerSpawnAttempt,
  createWorkerSpawnWorkItem,
  throwWithWorkItemReflectionFailure,
} from "./worker-work-item.js";
import { extractText } from "../../ingress/handlers.js";

export interface WorkerDispatchHandlerOptions
  extends Omit<WorkerCompletionOptions, "sourceOrigin" | "verifierRegistry"> {
  /**
   * Shared deterministic verifier registry (#549). Resolved once at handler
   * construction — completion projection never constructs its own.
   */
  readonly verifierRegistry?: WorkerCompletionOptions["verifierRegistry"];
  readonly coordinator?: CoordinatorLike;
  readonly connectorEndpointDriver?: ConnectorEndpointDriverOwner;
  readonly defaultModel?: Model.Ref;
  /**
   * Gate-side task policy stamping (#462 §7). The gate resolves labels into a
   * PolicyPlan and stamps it onto the delivered task; below the gate the plan
   * is opaque data — evaluation happens only inside the worker's agent loop.
   */
  readonly policyResolver?: PolicyResolverInstance;
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

function resolveCompletedWorkItem(
  command: Dispatch.Command,
  payload: WorkerCompletePayload,
): WorkItem.Info {
  const targetRunId = command.target.runId;
  if (!targetRunId) throw new Error("worker.complete requires target.runId");
  if (targetRunId !== payload.result.runId) {
    throw new Error(
      `worker.complete run mismatch: target=${targetRunId} result=${payload.result.runId}`,
    );
  }

  if (payload.workItemHash !== undefined) {
    const workItem = WorkItemStore.get(payload.workItemHash);
    if (!workItem) throw new Error(`worker.complete WorkItem not found: ${payload.workItemHash}`);
    if (workItem.workerRunId !== targetRunId) {
      throw new Error(
        `worker.complete run mismatch: workItem=${workItem.workerRunId ?? "missing"} target=${targetRunId}`,
      );
    }
    return workItem;
  }

  const matches = WorkItemStore.list().filter((item) => item.workerRunId === targetRunId);
  if (matches.length !== 1) {
    throw new Error(
      `worker.complete requires exactly one WorkItem for run ${targetRunId}: found ${matches.length}`,
    );
  }
  const workItem = matches[0];
  if (!workItem) throw new Error(`worker.complete WorkItem not found for run ${targetRunId}`);
  return workItem;
}

function assertWorkerCompletionActorAuthority(
  command: Dispatch.Command,
  payload: WorkerCompletePayload,
): void {
  const actor = command.actor;
  if (
    actor.kind !== "worker" ||
    actor.trustTier !== "assigned_worker" ||
    actor.workerRunId !== payload.result.runId ||
    actor.sessionId !== payload.result.sessionId
  ) {
    throw new Error("worker.complete actor is not authorized for this Worker result");
  }
  if (
    command.target.sessionId !== undefined &&
    command.target.sessionId !== payload.result.sessionId
  ) {
    throw new Error("worker.complete actor is not authorized for this Worker result");
  }
}

function assertWorkerCompletionWorkItemAuthority(
  payload: WorkerCompletePayload,
  workItem: WorkItem.Info,
): void {
  if (
    workItem.executorKind !== "connector_endpoint" ||
    workItem.workSessionId !== payload.result.sessionId
  ) {
    throw new Error("worker.complete actor is not authorized for this Worker result");
  }
  const workerRun = WorkerRunStateStore.get(payload.result.sessionId, payload.result.runId);
  if (!workerRun) {
    throw new Error(`worker.complete WorkerRun not found: ${payload.result.runId}`);
  }
  if (
    (workerRun.executorKind !== undefined && workerRun.executorKind !== workItem.executorKind) ||
    (workerRun.assignedStepId !== undefined && workerRun.assignedStepId !== workItem.hash) ||
    (workerRun.status !== "running" && workerRun.status !== "waiting_input")
  ) {
    throw new Error(
      `worker.complete WorkerRun is not assigned to this active WorkItem: executor=${workerRun.executorKind ?? "missing"} assignedStep=${workerRun.assignedStepId ?? "missing"} status=${workerRun.status}`,
    );
  }
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
  const policyResolver = options.policyResolver ?? PolicyResolver.create();
  const verifierRegistry = options.verifierRegistry ?? VerifierRegistry.create();
  return {
    async "worker.spawn"(command) {
      const payload = parseWorkerSpawnPayload(command.payload);
      if (isConnectorEndpointTarget(command.target)) {
        return handleConnectorEndpointWorkerSpawn(command, model, payload, {
          completionService: options.completionService,
          verifierRegistry,
          driver: options.connectorEndpointDriver,
          readBack: options.readBack,
          readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
          readBackRecorder: options.readBackRecorder,
          now: options.now,
        });
      }

      const coordinator = requireCoordinator(options.coordinator);
      const policyPlan = policyResolver.resolve({
        actorLabels: command.actor.labels ?? [],
        agentLabels: command.target.labels ?? [],
        runLabels: [],
        surfaceLabels: [],
      });
      const request = buildWorkerSpawnRequest(command, model, payload, policyPlan);
      const workItemHash = await createWorkerSpawnWorkItem(
        command,
        request,
        payload,
        INTERNAL_EXECUTOR_KIND,
      );
      // #510 C2: the attempt identity is appended on the work stream before
      // the executor acts; attemptId travels alongside workerRunId.
      const attemptId = await allocateWorkerSpawnAttempt(
        workItemHash,
        request.prompt,
        INTERNAL_EXECUTOR_KIND,
        { model, policyPlan, workspaceRoot: command.workspaceRoot },
      );
      let result: Execution.Result;
      try {
        result = await coordinator.dispatch(request.sessionId, request);
      } catch (err) {
        try {
          await WorkItemStore.fail(workItemHash, err instanceof Error ? err.message : String(err));
        } catch (reflectionFailure) {
          throwWithWorkItemReflectionFailure(err, reflectionFailure);
        }
        throw err;
      }
      const reflection = await reflectCoordinatorResult(workItemHash, result, {
        completionService: options.completionService,
        verifierRegistry,
        sourceOrigin: { source: "internal_worker" },
        readBack: options.readBack,
        readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
        readBackRecorder: options.readBackRecorder,
        now: options.now,
      });
      return {
        output: {
          sessionId: request.sessionId,
          runId: request.runId,
          workItemHash,
          attemptId,
          result,
          reflection,
        },
      };
    },

    async "worker.complete"(command) {
      const payload = parseWorkerCompletePayload(command.payload);
      assertWorkerCompletionActorAuthority(command, payload);
      const workItem = resolveCompletedWorkItem(command, payload);
      assertWorkerCompletionWorkItemAuthority(payload, workItem);
      const workItemHash = workItem.hash;
      const projection = await projectConnectorCompletion(workItemHash, payload.result, {
        completionService: options.completionService,
        verifierRegistry,
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
