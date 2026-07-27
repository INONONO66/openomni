import { createHash } from "node:crypto";
import { Execution, Ipc, type Ledger, type Model, type Tool } from "@openomni/protocol";
import { CronJobRunner, type FireSchedule } from "../execution-runtime/cron-job-runner.js";
import type { ScheduleFire, ScheduleProjectionV1 } from "../execution-runtime/schedule-service.js";
import { toWorkspaceRef, type WorkspaceIdentity } from "../execution-runtime/workspace-identity.js";
import { CronAdapter } from "../ingress/cron-adapter.js";
import { IngressEngine, type IngressKernelPorts } from "../ingress/engine.js";
import type {
  WaitKernelQueryService,
  WaitKernelTransitionService,
} from "../ingress/wait-correlation.js";
import type { KernelTransitionPortV1 } from "./ports.js";
import {
  createAuthorityProjectionQueryPort,
  createMessagingAccessServices,
  type MessagingAccessDependenciesV1,
  type MessagingAccessServicesV1,
  type MessagingAccessSnapshotBlobV1,
} from "./production/messaging-access.js";
import {
  createProductionScheduleEffectServices,
  type ProductionScheduleEffectDependencies,
  type ProductionScheduleEffectServices,
  type ScheduleEffectIncidentV1,
} from "./production/schedule-effect.js";
import {
  createProductionWorkerConnectorServices,
  type ActiveWorkerBindingV1,
  type ProductionConnectorDependencies,
  type ProductionProvisioningDependencies,
  type ProductionWorkerConnectorServices,
  type ProductionWorkerSemanticDependencies,
} from "./production/worker-connector.js";
import {
  createWorkWaitServices,
  type WorkAttemptRecordV1,
  type WorkRecordV1,
  type WorkWaitProductionConfigV1,
  type WorkWaitProjectionPortV1,
  type WorkWaitServicesV1,
  type WorkWaitTransitionPortV1,
} from "./production/work-wait.js";

export interface ProductionKernelStructuralPorts {
  readonly messagingAccess: Pick<MessagingAccessDependenciesV1, "transitions" | "projections">;
  readonly workWait: Readonly<{
    projections: WorkWaitProjectionPortV1;
    transitions: WorkWaitTransitionPortV1;
  }>;
  readonly scheduleEffect: Omit<
    ProductionScheduleEffectDependencies,
    "workspaceId" | "incidents" | "now"
  >;
  readonly workerConnector: Readonly<{
    worker: Omit<ProductionWorkerSemanticDependencies, "workerLedger"> &
      Readonly<{ transitions: KernelTransitionPortV1 }>;
    connector: Omit<ProductionConnectorDependencies, "workspaceRoot" | "modelEnvironment">;
    provisioning: Omit<ProductionProvisioningDependencies, "model" | "now">;
  }>;
  readonly views: Readonly<{
    openWorks(): Promise<readonly WorkRecordV1[]>;
    attemptsByWork(workItemId: string): Promise<readonly WorkAttemptRecordV1[]>;
    attemptsBySession(sessionId: string): Promise<readonly WorkAttemptRecordV1[]>;
    sessionEvents(sessionId: string): Promise<readonly Ledger.EnvelopeV1[]>;
  }>;
}

export interface ProductionKernelConfig {
  readonly model: Model.Ref;
  readonly modelEnvironment: Execution.LLMEnvironmentV1;
  readonly workspaceIdentity: WorkspaceIdentity;
}

export interface ProductionKernelClockPort {
  now(): number;
}

export interface ProductionKernelIncidentPort {
  report(incident: ScheduleEffectIncidentV1): void;
}

export interface ProductionObservationV1 {
  readonly version: "production-observation-v1";
  readonly kind: "worker" | "connector" | "schedule" | "recovery";
  readonly subjectId: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ProductionKernelDriverHostPort {
  observe(event: ProductionObservationV1): Promise<void>;
}

export interface ProductionKernelFactoryInput extends ProductionKernelStructuralPorts {
  readonly config: ProductionKernelConfig;
  readonly clock: ProductionKernelClockPort;
  readonly incidents: ProductionKernelIncidentPort;
  readonly host: ProductionKernelDriverHostPort;
}

export type ProductionKernelContext = Pick<
  ProductionKernelFactoryInput,
  "clock" | "incidents" | "host"
>;

export interface ProductionSnapshotBlob extends MessagingAccessSnapshotBlobV1 {}

export interface ProductionRuntimeAgentV1 {
  readonly name: string;
  readonly description: string;
  readonly model: Model.Ref;
  readonly systemPrompt: string;
  readonly tools: unknown;
  readonly permissions?: unknown;
  readonly policyPlan?: unknown;
  readonly budget?: unknown;
}

export interface ProductionRuntimeToolV1 {
  readonly spec: Tool.Spec;
}

export interface ProductionRuntimeBootstrapV1 {
  readonly configEpoch: string;
  readonly agents: readonly ProductionRuntimeAgentV1[];
  readonly toolCatalog: readonly ProductionRuntimeToolV1[];
}

export interface ProductionWorkerProcessBindingV1 {
  readonly runtimeId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly principalId: string;
  readonly processId: number;
}

export interface ProductionWorkerTaskV1 {
  readonly runId: string;
  readonly sessionId: string;
  readonly prompt: string;
}

export interface OwnerTaskProjectionV1 {
  readonly id: string;
  readonly name: string;
  readonly status: "pending" | "running" | "blocked" | "failed";
  readonly activeBlockerCount?: number;
  readonly attempt?: number;
  readonly assigneeLabel?: string;
  readonly sessionLabel?: string;
}

export interface OwnerSessionObservabilityV1 {
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly errors: readonly Readonly<{ eventType: string; traceId: string; timeCreated: number }>[];
  readonly workerRuns: readonly Readonly<{
    runId: string;
    status: string;
    startedAt?: number;
    endedAt?: number;
  }>[];
  readonly chainIntegrity: Readonly<{
    verification: "canonical_event_hash_and_owner_linkage_v1";
    valid: boolean;
    eventCount: number;
  }>;
}

export interface ProductionCronStartOptionsV1 {
  readonly service: ProductionScheduleEffectServices["schedule"];
  readonly fire: FireSchedule;
}

export interface ProductionCronSemanticServiceV1 {
  start(input: ProductionCronStartOptionsV1): ReturnType<typeof CronJobRunner.start>;
  fire: FireSchedule;
}

export interface ProductionSemanticServices {
  readonly messagingLedger: MessagingAccessServicesV1["messaging"];
  readonly ingressKernel: IngressKernelPorts;
  readonly authorityQueries: MessagingAccessServicesV1["authority"];
  readonly workerAttempts: WorkWaitServicesV1["workerAttempts"];
  readonly workerLedger: WorkWaitServicesV1["workerLedger"];
  readonly waitKernel: WorkWaitServicesV1["waitKernel"];
  readonly residentAskLifecycle: WorkWaitServicesV1["messagingWaitLifecycle"];
  readonly workCompletion: WorkWaitServicesV1["workCompletion"];
  readonly scheduleService: ProductionScheduleEffectServices["schedule"];
  readonly effects: ProductionScheduleEffectServices["effects"];
  readonly recovery: Readonly<{
    runs: Readonly<{
      queries: Readonly<{
        interruptedRuns(): Promise<readonly Readonly<{ sessionId: string; runId: string }>[]>;
      }>;
      commands: Readonly<{
        interruptRun(
          input: Readonly<{ sessionId: string; runId: string; requestId: string; reason: string }>,
        ): Promise<"recovered" | "unchanged">;
      }>;
    }>;
    messages: Readonly<{
      queries: Readonly<{
        interruptedMessages(): Promise<
          readonly Readonly<{ sessionId: string; messageId: string }>[]
        >;
      }>;
      commands: Readonly<{
        reconcileInterruptedMessage(
          input: Readonly<{ sessionId: string; messageId: string; requestId: string }>,
        ): Promise<"recovered" | "unchanged">;
      }>;
    }>;
  }>;
  readonly recoverInterruptedRuns: () => Promise<
    Readonly<{ recovered: number; sessions: string[] }>
  >;
  readonly connectorQueries: ProductionWorkerConnectorServices["connector"]["queries"];
  readonly connectorTransitions: ProductionWorkerConnectorServices["connector"]["transitions"];
  readonly connectorArtifacts: ProductionWorkerConnectorServices["connector"]["artifacts"];
  readonly workerKernelTransition: ProductionWorkerConnectorServices["worker"]["transition"];
  readonly workerKernelQuery: ProductionWorkerConnectorServices["worker"]["query"];
  readonly credentialProvisioning: ProductionWorkerConnectorServices["provisioning"];
  readonly runtimeDefinitions: Readonly<{
    create(
      bootstrap: ProductionRuntimeBootstrapV1,
      binding: ProductionWorkerProcessBindingV1,
      task: ProductionWorkerTaskV1,
      credentialRef: Execution.CredentialSourceRefV1,
    ): Promise<Ipc.WorkerRuntimeDefinitionV1>;
  }>;
  readonly ownerTaskQueries: Readonly<{
    listOpenTasks(): Promise<readonly OwnerTaskProjectionV1[]>;
  }>;
  readonly observabilityQueries: Readonly<{
    session(sessionId: string): Promise<OwnerSessionObservabilityV1>;
  }>;
  readonly cron: ProductionCronSemanticServiceV1;
  readonly observations: ProductionKernelDriverHostPort;
}

export const createAuthorityServices = createAuthorityProjectionQueryPort;

export function createProductionSnapshotBlob(value: unknown): ProductionSnapshotBlob {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return Object.freeze({
    bytes,
    ref: Object.freeze({
      version: "content-blob-ref-v1",
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: "application/json",
    }),
  });
}

export function createProductionKernelServices(
  input: ProductionKernelFactoryInput,
): ProductionSemanticServices {
  const now = () => input.clock.now();
  const activeBindings = new Map<string, ActiveWorkerBindingV1>();
  const messagingAccess = createMessagingAccessServices({
    ...input.messagingAccess,
    snapshot: (family, state) =>
      createProductionSnapshotBlob({ version: `${family}-projection-state-v1`, state }),
    residentEffectScope: (sourceRef) => productionEffectScope(input.config, sourceRef),
  });
  const workWait = createWorkWaitServices(input.workWait.projections, input.workWait.transitions, {
    model: input.config.model,
    modelEnvironment: input.config.modelEnvironment,
    now,
    workerEffectScope: (sourceRef, operation) =>
      productionEffectScope(input.config, sourceRef, operation),
  } satisfies WorkWaitProductionConfigV1);
  const scheduleEffect = createProductionScheduleEffectServices({
    ...input.scheduleEffect,
    workspaceId: input.config.workspaceIdentity.workspaceId,
    incidents: input.incidents,
    now,
  });
  const workerConnector = createProductionWorkerConnectorServices({
    worker: {
      projections: input.workerConnector.worker.projections,
      queries: {
        ...input.workerConnector.worker.queries,
        async attemptByRunId(runId) {
          const row = await input.workerConnector.worker.queries.attemptByRunId(runId);
          if (row === undefined) return undefined;
          const binding = activeBindings.get(row.attempt.attemptId);
          return binding === undefined ? row : { ...row, binding };
        },
      },
      workerLedger: workWait.workerLedger,
    },
    connector: {
      ...input.workerConnector.connector,
      workspaceRoot: input.config.workspaceIdentity.canonicalRoot,
      modelEnvironment: input.config.modelEnvironment,
    },
    provisioning: {
      ...input.workerConnector.provisioning,
      queries: {
        ...input.workerConnector.provisioning.queries,
        async attempt(attemptId) {
          const row = await input.workerConnector.provisioning.queries.attempt(attemptId);
          const binding = activeBindings.get(attemptId);
          return row === undefined || binding === undefined ? undefined : { ...row, binding };
        },
      },
      model: input.config.model,
      now,
    },
  });

  const runtimeDefinitions = Object.freeze({
    async create(
      bootstrap: ProductionRuntimeBootstrapV1,
      binding: ProductionWorkerProcessBindingV1,
      task: ProductionWorkerTaskV1,
      credentialRef: Execution.CredentialSourceRefV1,
    ): Promise<Ipc.WorkerRuntimeDefinitionV1> {
      const attempt = await workWait.runtimeAttempts.byExecution(task);
      if (
        attempt === undefined ||
        attempt.status !== "starting" ||
        attempt.prompt !== task.prompt ||
        attempt.model.provider !== input.config.model.provider ||
        attempt.model.id !== input.config.model.id
      ) {
        throw new Error("worker runtime definition denied");
      }
      const candidates = bootstrap.agents.filter((agent) => agent.name === attempt.agentName);
      const agent = candidates[0];
      if (agent === undefined || candidates.length !== 1) {
        throw new Error("worker runtime definition denied");
      }
      if (
        agent.model.provider !== input.config.model.provider ||
        agent.model.id !== input.config.model.id ||
        credentialRef.providerId !== input.config.model.provider ||
        credentialRef.sourceKind !== "injected_runtime"
      ) {
        throw new Error("worker runtime definition denied");
      }
      const attemptRef: Ledger.AttemptRefV1 = Object.freeze({
        version: "attempt-ref-v1",
        workItemId: attempt.workItemId,
        attemptId: attempt.attemptId,
        attemptSeq: attempt.attemptSeq,
      });
      const { environmentDigest: _ownerEnvironmentDigest, ...environmentBase } =
        input.config.modelEnvironment;
      if (_ownerEnvironmentDigest.length !== 64)
        throw new Error("worker runtime definition denied");
      const workerEnvironmentBase = { ...environmentBase, credential: credentialRef };
      const environment = Execution.LLMEnvironmentV1.parse({
        ...workerEnvironmentBase,
        environmentDigest: createHash("sha256")
          .update(canonicalJson(workerEnvironmentBase))
          .digest("hex"),
      });
      const definition = Ipc.WorkerRuntimeDefinitionV1.parse({
        runtimeId: binding.runtimeId,
        workerId: binding.workerId,
        generation: binding.generation,
        principalId: binding.principalId,
        attempt: attemptRef,
        config: {
          configEpoch: bootstrap.configEpoch,
          model: input.config.model,
          environment,
          workspace: toWorkspaceRef(input.config.workspaceIdentity),
          agents: [agent],
          toolCatalog: bootstrap.toolCatalog.map(({ spec }) => spec),
          ...(agent.budget === undefined ? {} : { budget: agent.budget }),
        },
      });
      activeBindings.set(
        attempt.attemptId,
        Object.freeze({
          ...binding,
          sessionId: attempt.sessionId,
          runId: attempt.runId,
          attempt: attemptRef,
        }),
      );
      return definition;
    },
  });

  const recoverInterruptedRuns = async () => {
    const sessions = new Set<string>();
    let recovered = 0;
    for (const run of await scheduleEffect.recovery.runs.interruptedRuns()) {
      const result = await scheduleEffect.recovery.runs.interruptRun({
        sessionId: run.sessionId,
        runId: run.state.runId,
      });
      if (result === "recovered") {
        recovered += 1;
        sessions.add(run.sessionId);
      }
    }
    return Object.freeze({ recovered, sessions: [...sessions] });
  };

  const ownerTaskQueries = Object.freeze({
    async listOpenTasks(): Promise<readonly OwnerTaskProjectionV1[]> {
      return Promise.all(
        (await input.views.openWorks()).map(async (work) => {
          const attempts = await input.views.attemptsByWork(work.workItemId);
          const attempt = [...attempts].sort(
            (left: WorkAttemptRecordV1, right: WorkAttemptRecordV1) =>
              right.attemptSeq - left.attemptSeq,
          )[0];
          const blockerCount = work.activeBlockerRefs?.length ?? 0;
          const status: OwnerTaskProjectionV1["status"] =
            work.status === "failed"
              ? "failed"
              : blockerCount > 0
                ? "blocked"
                : attempt?.status === "running" ||
                    attempt?.status === "starting" ||
                    attempt?.status === "waiting"
                  ? "running"
                  : "pending";
          return Object.freeze({
            id: work.workItemId,
            name: work.title,
            status,
            ...(blockerCount === 0 ? {} : { activeBlockerCount: blockerCount }),
            ...(attempt === undefined
              ? {}
              : { attempt: attempt.attemptSeq, assigneeLabel: attempt.agentName }),
            sessionLabel: work.sessionId,
          });
        }),
      );
    },
  });

  const observabilityQueries = Object.freeze({
    async session(sessionId: string): Promise<OwnerSessionObservabilityV1> {
      const [events, attempts] = await Promise.all([
        input.views.sessionEvents(sessionId),
        input.views.attemptsBySession(sessionId),
      ]);
      const eventCounts: Record<string, number> = {};
      for (const envelope of events) {
        eventCounts[envelope.event.eventType] = (eventCounts[envelope.event.eventType] ?? 0) + 1;
      }
      const ownerHeads = new Map<string, { ownerSeq: number; eventHash: string }>();
      const valid = events.every((envelope) => {
        const ownerKey = envelope.event.owner.ownerKey;
        const previous = ownerHeads.get(ownerKey);
        const expectedPreviousHash = previous?.eventHash ?? "GENESIS_V1";
        const expectedOwnerSeq = (previous?.ownerSeq ?? 0) + 1;
        const expectedEventHash = createHash("sha256")
          .update(
            canonicalJson({
              version: "ledger-envelope-v1",
              envelopeVersion: envelope.envelopeVersion,
              event: envelope.event,
              batchId: envelope.batch.batchId,
              batchIndex: envelope.batch.index,
              batchSize: envelope.batch.size,
              ownerSeq: envelope.ownerSeq,
              previousEventHash: envelope.previousEventHash,
              requestId: envelope.requestId,
              requestHash: envelope.requestHash,
              principalId: envelope.principalId,
            }),
          )
          .digest("hex");
        if (
          envelope.ownerSeq !== expectedOwnerSeq ||
          envelope.previousEventHash !== expectedPreviousHash ||
          envelope.eventHash !== expectedEventHash
        ) {
          return false;
        }
        ownerHeads.set(ownerKey, {
          ownerSeq: envelope.ownerSeq,
          eventHash: envelope.eventHash,
        });
        return true;
      });
      return Object.freeze({
        eventCounts: Object.freeze(eventCounts),
        errors: Object.freeze(
          events
            .filter(
              ({ event }) =>
                event.eventType.includes("failed") || event.eventType.includes("interrupted"),
            )
            .map((envelope) =>
              Object.freeze({
                eventType: envelope.event.eventType,
                traceId: envelope.requestId,
                timeCreated: envelope.committedAtDbMs,
              }),
            ),
        ),
        workerRuns: Object.freeze(
          attempts.map((attempt) =>
            Object.freeze({
              runId: attempt.runId,
              status: attempt.status,
            }),
          ),
        ),
        chainIntegrity: Object.freeze({
          verification: "canonical_event_hash_and_owner_linkage_v1",
          valid,
          eventCount: events.length,
        }),
      });
    },
  });
  const waitQueries: WaitKernelQueryService = Object.freeze({
    correlate: (request: Parameters<WaitKernelQueryService["correlate"]>[0]) =>
      workWait.waitKernel.correlate(request),
    revalidatePinned: (request: Parameters<WaitKernelQueryService["revalidatePinned"]>[0]) =>
      workWait.waitKernel.revalidatePinned(request),
  });
  const waitTransitions: WaitKernelTransitionService = Object.freeze({
    acceptResponse: (request: Parameters<WaitKernelTransitionService["acceptResponse"]>[0]) =>
      workWait.waitKernel.acceptResponse(request),
    settle: (request: Parameters<WaitKernelTransitionService["settle"]>[0]) =>
      workWait.waitKernel.settle(request),
    cancel: (request: Parameters<WaitKernelTransitionService["cancel"]>[0]) =>
      workWait.waitKernel.cancel(request),
    stageAmbiguity: (request: Parameters<WaitKernelTransitionService["stageAmbiguity"]>[0]) =>
      workWait.waitKernel.stageAmbiguity(request),
    markRouted: (request: Parameters<WaitKernelTransitionService["markRouted"]>[0]) =>
      workWait.waitKernel.markRouted(request),
  });

  const cronOptions: CronAdapter.Options = { ingress: IngressEngine, nowMs: now };
  const cronIngress = CronAdapter.create(cronOptions);
  const cron: ProductionCronSemanticServiceV1 = Object.freeze({
    start: (options: ProductionCronStartOptionsV1) => CronJobRunner.start(options),
    async fire(job: ScheduleProjectionV1, fire: ScheduleFire): Promise<void> {
      const cronJob: CronAdapter.CronJob = {
        id: job.scheduleId,
        agentName: job.agentName,
        payload: job.payloadRef,
        target: {
          kind: job.target.kind,
          ...(job.target.sessionId === undefined ? {} : { sessionId: job.target.sessionId }),
        },
      };
      await cronIngress.fire(cronJob, fire);
    },
  });

  return Object.freeze({
    messagingLedger: messagingAccess.messaging,
    ingressKernel: Object.freeze({
      authorityQueries: messagingAccess.authority,
      waitQueries,
      waitTransitions,
      workerAttempts: workWait.workerAttempts,
    }),
    authorityQueries: messagingAccess.authority,
    workerAttempts: workWait.workerAttempts,
    workerLedger: workWait.workerLedger,
    waitKernel: workWait.waitKernel,
    residentAskLifecycle: workWait.messagingWaitLifecycle,
    workCompletion: workWait.workCompletion,
    scheduleService: scheduleEffect.schedule,
    effects: scheduleEffect.effects,
    recovery: Object.freeze({
      runs: Object.freeze({
        queries: Object.freeze({
          interruptedRuns: async () =>
            (await scheduleEffect.recovery.runs.interruptedRuns()).map((run) => ({
              sessionId: run.sessionId,
              runId: run.state.runId,
            })),
        }),
        commands: Object.freeze({
          interruptRun: (
            request: Readonly<{
              sessionId: string;
              runId: string;
              requestId: string;
              reason: string;
            }>,
          ) => scheduleEffect.recovery.runs.interruptRun(request),
        }),
      }),
      messages: Object.freeze({
        queries: Object.freeze({
          interruptedMessages: scheduleEffect.recovery.messages.interruptedMessages,
        }),
        commands: Object.freeze({
          reconcileInterruptedMessage: scheduleEffect.recovery.messages.reconcileInterruptedMessage,
        }),
      }),
    }),
    recoverInterruptedRuns,
    connectorQueries: workerConnector.connector.queries,
    connectorTransitions: workerConnector.connector.transitions,
    connectorArtifacts: workerConnector.connector.artifacts,
    workerKernelTransition: workerConnector.worker.transition,
    workerKernelQuery: workerConnector.worker.query,
    credentialProvisioning: workerConnector.provisioning,
    runtimeDefinitions,
    ownerTaskQueries,
    observabilityQueries,
    cron,
    observations: Object.freeze({
      observe: (event: ProductionObservationV1) => input.host.observe(event),
    }),
  });
}

function productionEffectScope(
  config: ProductionKernelConfig,
  sourceRef: string,
  operation = "resident.run.v1",
): Execution.EffectScopeV1 {
  const inputDigest = createHash("sha256").update(sourceRef).digest("hex");
  if (!/^[a-z][a-z0-9_.-]*\.v1$/.test(operation))
    throw new TypeError("Effect operation is not versioned");
  const operationVariant = `${operation.slice(0, -3).split(".").join("_")}.v1`;
  return Execution.EffectScopeV1.parse({
    version: "effect-scope-v1",
    workspace: toWorkspaceRef(config.workspaceIdentity),
    resources: [
      {
        version: "resource-scope-v1",
        kind: "registered",
        variant: operationVariant,
        targetDigest: inputDigest,
      },
    ],
    resolver: { id: "openomni.production-effect-scope", version: "1", inputDigest },
    containment: "none",
    mutationClass: "mutating",
  });
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}
