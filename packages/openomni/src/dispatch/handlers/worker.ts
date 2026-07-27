import { Execution, type Dispatch, Model } from "@openomni/protocol";
import { z } from "zod";
import type { CoordinatorLike } from "../../ingress/coordinator-like.js";
import type {
  WorkerAttemptLifecycleService,
  WorkerAttemptProjection,
} from "../../ingress/handler-worker-run.js";
import { PolicyResolver, type PolicyResolverInstance } from "../../policy/index.js";
import type { ConnectorEndpointDriverOwner } from "../owners.js";
import type { DispatchHandler } from "../registry.js";
import {
  handleConnectorEndpointWorkerSpawn,
  isConnectorEndpointTarget,
} from "./connector-endpoint-worker.js";
import { projectConnectorCompletion } from "./connector-completion-projector.js";
import {
  reflectCoordinatorResult,
  requireWorkerLedger,
  type WorkerCompletionOptions,
} from "./worker-completion.js";
import { buildWorkerSpawnRequest, parseWorkerSpawnPayload } from "./worker-spawn-payload.js";
import {
  commitWorkerLedgerTransition,
  createWorkerSpawnWorkItem,
  type WorkerLedgerBinding,
  type WorkerLedgerService,
  type WorkerSemanticEffectBindingV1,
} from "./worker-work-item.js";
import { extractText } from "./shared.js";

export interface WorkerDispatchHandlerOptions extends WorkerCompletionOptions {
  readonly coordinator?: CoordinatorLike;
  readonly connectorEndpointDriver?: ConnectorEndpointDriverOwner;
  readonly defaultModel?: Model.Ref;
  readonly workerAttempts?: WorkerAttemptLifecycleService;
  /**
   * Gate-side task policy stamping (#462 §7). The gate resolves labels into a
   * PolicyPlan and stamps it onto the delivered task; below the gate the plan
   * is opaque data — evaluation happens only inside the worker's agent loop.
   */
  readonly policyResolver?: PolicyResolverInstance;
}

const WorkerCompletePayload = z
  .object({
    workItemHash: z.string().min(1).optional(),
    result: Execution.Result,
  })
  .strict();
type WorkerCompletePayload = z.infer<typeof WorkerCompletePayload>;

export type WorkerModelConfigurationErrorCode = "dispatch_model_missing" | "dispatch_model_invalid";

export class WorkerModelConfigurationError extends Error {
  readonly code: WorkerModelConfigurationErrorCode;

  constructor(code: WorkerModelConfigurationErrorCode) {
    super(code);
    this.name = "WorkerModelConfigurationError";
    this.code = code;
  }
}

function requireModel(model: Model.Ref | undefined): Model.Ref {
  if (model === undefined) {
    throw new WorkerModelConfigurationError("dispatch_model_missing");
  }
  const parsed = Model.Ref.safeParse(model);
  if (!parsed.success) {
    throw new WorkerModelConfigurationError("dispatch_model_invalid");
  }
  return parsed.data;
}

function requireCoordinator(coordinator: CoordinatorLike | undefined): CoordinatorLike {
  if (!coordinator) throw new Error("dispatch worker handler requires coordinator owner");
  return coordinator;
}

function requireWorkerAttempts(
  workerAttempts: WorkerAttemptLifecycleService | undefined,
): WorkerAttemptLifecycleService {
  if (!workerAttempts) throw new Error("dispatch worker handler requires worker attempt service");
  return workerAttempts;
}

async function allocateWorkerAttempt(
  command: Dispatch.Command,
  payload: ReturnType<typeof parseWorkerSpawnPayload>,
  ledger: WorkerLedgerService,
  workerAttempts: WorkerAttemptLifecycleService,
): Promise<Readonly<{ attempt: WorkerAttemptProjection; binding: WorkerLedgerBinding }>> {
  const sessionId = command.target.sessionId ?? command.sessionId ?? crypto.randomUUID();
  const runId = command.target.runId ?? command.runId ?? crypto.randomUUID();
  const binding = await createWorkerSpawnWorkItem(
    command,
    {
      sessionId,
      runId,
      prompt: payload.prompt,
      agentName: command.target.id ?? command.target.name ?? "worker",
    },
    payload,
    "internal_chat_agent",
    ledger,
  );
  const attempt = await workerAttempts.queries.byExecution({ sessionId, runId });
  if (
    !attempt ||
    attempt.sessionId !== sessionId ||
    attempt.runId !== binding.runId ||
    attempt.workItemId !== binding.workItemId ||
    attempt.attemptId !== binding.attempt.attemptId ||
    attempt.attemptSeq !== binding.attempt.attemptSeq
  ) {
    throw new Error(`Committed Attempt projection mismatch for run ${runId}`);
  }
  await workerAttempts.commands.requestStart(attempt);
  return { attempt, binding };
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

async function resolveCompletedWorkItem(
  ledger: WorkerLedgerService,
  command: Dispatch.Command,
  payload: WorkerCompletePayload,
): Promise<WorkerLedgerBinding> {
  const workerRunId = command.target.runId ?? payload.result.runId;
  const attempt = await ledger.resolveAttemptByRunId(workerRunId);
  const work = await ledger.resolveWorkByRunId(workerRunId);
  if (!attempt || !work || attempt.workItemId !== work.workItemId) {
    throw new Error(`worker.complete could not resolve native Work/Attempt for run ${workerRunId}`);
  }
  if (payload.workItemHash !== undefined && payload.workItemHash !== work.workItemId) {
    throw new Error(
      `worker.complete workItemHash does not match native Work for run ${workerRunId}`,
    );
  }
  return work;
}

async function resolveWorkerAttempt(
  ledger: WorkerLedgerService,
  runId: string,
): Promise<WorkerLedgerBinding> {
  const attempt = await ledger.resolveAttemptByRunId(runId);
  if (!attempt)
    throw new Error(`dispatch could not resolve native Worker Attempt for run ${runId}`);
  return attempt;
}

type WorkerEffectOutcome = "confirmed" | "definite_failed" | "unknown";

function coordinatorOutcome(result: unknown, field: "accepted" | "cancelled"): WorkerEffectOutcome {
  if (result === null || typeof result !== "object") return "unknown";
  const value = (result as Record<string, unknown>)[field];
  return value === true ? "confirmed" : value === false ? "definite_failed" : "unknown";
}

async function settleWorkerEffect(
  ledger: WorkerLedgerService,
  binding: WorkerLedgerBinding,
  effectBinding: WorkerSemanticEffectBindingV1,
  outcome: WorkerEffectOutcome,
  requestKey: string,
): Promise<void> {
  const transition =
    outcome === "confirmed"
      ? ({ transitionId: "EF-01", command: "kernel.effect.confirm.v1" } as const)
      : outcome === "definite_failed"
        ? ({ transitionId: "EF-02", command: "kernel.effect.fail_definite.v1" } as const)
        : ({ transitionId: "EF-03", command: "kernel.effect.mark_unknown.v1" } as const);
  await commitWorkerLedgerTransition(ledger, binding, {
    ...transition,
    requestKey: `${requestKey}:settlement`,
    effectBinding,
    facts: { outcome },
  });
}

async function recordWorkerEffectIntent(
  ledger: WorkerLedgerService,
  binding: WorkerLedgerBinding,
  input: {
    readonly transitionId: "DP-12" | "DP-13" | "DP-14";
    readonly command:
      | "kernel.dispatch.message_worker.v1"
      | "kernel.dispatch.resume_wait.v1"
      | "kernel.dispatch.ensure_cancel.v1";
    readonly requestKey: string;
    readonly facts: unknown;
  },
): Promise<WorkerSemanticEffectBindingV1> {
  const effectBinding = await commitWorkerLedgerTransition(ledger, binding, input);
  if (!effectBinding) {
    throw new Error(`${input.command} committed without an exact effect binding`);
  }
  return effectBinding;
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
  const policyResolver = options.policyResolver ?? PolicyResolver.create();
  return {
    async "worker.spawn"(command) {
      const model = requireModel(options.defaultModel);
      const payload = parseWorkerSpawnPayload(command.payload);
      if (isConnectorEndpointTarget(command.target)) {
        return handleConnectorEndpointWorkerSpawn(command, model, payload, {
          driver: options.connectorEndpointDriver,
        });
      }

      const ledger = requireWorkerLedger(options.ledger);
      const coordinator = requireCoordinator(options.coordinator);
      const workerAttempts = requireWorkerAttempts(options.workerAttempts);
      const { attempt: allocation, binding } = await allocateWorkerAttempt(
        command,
        payload,
        ledger,
        workerAttempts,
      );
      const policyPlan = policyResolver.resolve({
        actorLabels: command.actor.labels ?? [],
        agentLabels: command.target.labels ?? [],
        runLabels: [],
        surfaceLabels: [],
      });
      const request = buildWorkerSpawnRequest(command, model, payload, allocation, policyPlan);
      let result: Execution.Result;
      try {
        result = await coordinator.dispatch(request.sessionId, request);
      } catch (err) {
        await commitWorkerLedgerTransition(ledger, binding, {
          transitionId: "DP-10",
          command: "kernel.dispatch.fail_work.v1",
          requestKey: `${binding.runId}:dispatch-failed`,
          facts: { reason: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
      const reflection = await reflectCoordinatorResult(binding, result, {
        ledger,
        readBack: options.readBack,
        readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
        readBackRecorder: options.readBackRecorder,
        now: options.now,
      });
      return {
        output: {
          sessionId: request.sessionId,
          runId: request.runId,
          workItemHash: binding.workItemId,
          attemptId: allocation.attemptId,
          result,
          reflection,
        },
      };
    },

    async "worker.complete"(command) {
      const ledger = requireWorkerLedger(options.ledger);
      const payload = parseWorkerCompletePayload(command.payload);
      const binding = await resolveCompletedWorkItem(ledger, command, payload);
      const projection = await projectConnectorCompletion(binding, payload.result, {
        ledger,
        readBack: options.readBack,
        readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
        readBackRecorder: options.readBackRecorder,
        now: options.now,
      });
      return {
        output: {
          workItemHash: binding.workItemId,
          runId: payload.result.runId,
          sessionId: payload.result.sessionId,
          result: payload.result,
          reflection: projection.reflection,
        },
      };
    },

    async "worker.send"(command) {
      const ledger = requireWorkerLedger(options.ledger);
      const coordinator = requireCoordinator(options.coordinator);
      if (!coordinator.deliverMessage) {
        throw new Error("dispatch worker.send requires coordinator.deliverMessage owner");
      }
      const sessionId = command.target.sessionId ?? command.sessionId;
      if (!sessionId) throw new Error("worker.send requires target.sessionId");
      const runId = targetRunId(command);
      if (!runId) throw new Error("worker.send requires target.runId or target.id");
      const text = extractText(command.payload);
      const binding = await resolveWorkerAttempt(ledger, runId);
      const effectBinding = await recordWorkerEffectIntent(ledger, binding, {
        transitionId: "DP-12",
        command: "kernel.dispatch.message_worker.v1",
        requestKey: command.dispatchId,
        facts: { dispatchId: command.dispatchId, sessionId, runId, message: text },
      });
      let result: unknown;
      try {
        result = await coordinator.deliverMessage(sessionId, text, runId);
      } catch (error) {
        await settleWorkerEffect(ledger, binding, effectBinding, "unknown", command.dispatchId);
        throw error;
      }
      const outcome = coordinatorOutcome(result, "accepted");
      await settleWorkerEffect(ledger, binding, effectBinding, outcome, command.dispatchId);
      return { output: { delivered: outcome === "confirmed", sessionId, runId, result } };
    },

    async "worker.resume"(command) {
      const ledger = requireWorkerLedger(options.ledger);
      const coordinator = requireCoordinator(options.coordinator);
      if (!coordinator.deliverMessage) {
        throw new Error("dispatch worker.resume requires coordinator.deliverMessage owner");
      }
      const sessionId = command.target.sessionId ?? command.sessionId;
      if (!sessionId) throw new Error("worker.resume requires target.sessionId");
      const runId = targetRunId(command);
      if (!runId) throw new Error("worker.resume requires target.runId or target.id");
      const text = extractText(command.payload);
      const binding = await resolveWorkerAttempt(ledger, runId);
      const effectBinding = await recordWorkerEffectIntent(ledger, binding, {
        transitionId: "DP-13",
        command: "kernel.dispatch.resume_wait.v1",
        requestKey: command.dispatchId,
        facts: { dispatchId: command.dispatchId, sessionId, runId, message: text },
      });
      let result: unknown;
      try {
        result = await coordinator.deliverMessage(sessionId, text, runId);
      } catch (error) {
        await settleWorkerEffect(ledger, binding, effectBinding, "unknown", command.dispatchId);
        throw error;
      }
      const outcome = coordinatorOutcome(result, "accepted");
      await settleWorkerEffect(ledger, binding, effectBinding, outcome, command.dispatchId);
      return { output: { resumed: outcome === "confirmed", sessionId, runId, result } };
    },

    async "worker.cancel"(command) {
      const ledger = requireWorkerLedger(options.ledger);
      const coordinator = requireCoordinator(options.coordinator);
      if (!coordinator.cancelRun) {
        throw new Error("dispatch worker.cancel requires coordinator.cancelRun owner");
      }
      const runId = targetRunId(command);
      if (!runId) throw new Error("worker.cancel requires target.runId or target.id");
      const binding = await resolveWorkerAttempt(ledger, runId);
      const effectBinding = await recordWorkerEffectIntent(ledger, binding, {
        transitionId: "DP-14",
        command: "kernel.dispatch.ensure_cancel.v1",
        requestKey: command.dispatchId,
        facts: { dispatchId: command.dispatchId, runId },
      });
      let result: unknown;
      try {
        result = await coordinator.cancelRun(runId);
      } catch (error) {
        await settleWorkerEffect(ledger, binding, effectBinding, "unknown", command.dispatchId);
        throw error;
      }
      const outcome = coordinatorOutcome(result, "cancelled");
      await settleWorkerEffect(ledger, binding, effectBinding, outcome, command.dispatchId);
      return { output: { cancelled: outcome === "confirmed", runId, result } };
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
