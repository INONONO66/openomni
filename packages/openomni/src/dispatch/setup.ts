import { PolicyEngine } from "@openomni/policy";
import { WorkItem } from "@openomni/protocol";
import type { Storage } from "@openomni/session";
import { CronJobRegistry } from "../execution-runtime/cron-job-registry.js";
import type { ReadBackExecutor } from "../evidence/read-back-executor.js";
import type { PolicyResolverInstance } from "../policy/index.js";
import {
  createWorkItemCompletionGateway,
  type CompletionAdmissionService,
  type WorkItemCompletionGateway,
} from "../work-item/completion-admission.js";
import type { DispatchRegistry } from "./registry.js";
import { DispatchRuntime, type DispatchRuntimeOptions } from "./runtime.js";
import type { DispatchOwners } from "./owners.js";
import { createDeviceDispatchHandlers } from "./handlers/device.js";
import { createOutboundDispatchHandlers } from "./handlers/outbound.js";
import { createResidentDispatchHandlers } from "./handlers/resident.js";
import { createScheduleDispatchHandlers } from "./handlers/schedule.js";
import type { WorkerCompletionOptions } from "./handlers/worker-completion.js";
import { createWorkerDispatchHandlers } from "./handlers/worker.js";

type CompletionPolicyEngine = ReturnType<typeof PolicyEngine.create>;

/** The single completion DI knob: a whole admission service, recovery optional. */
type DispatchCompletionAdmissionService = CompletionAdmissionService &
  Partial<Pick<WorkItemCompletionGateway, "recoverRecordedCompletions">>;

export interface BuiltInDispatchOptions {
  readonly completionAdmissionService?: DispatchCompletionAdmissionService;
  readonly completionWriter?: Storage.WorkItemCompletionWriter;
  readonly completionPolicyEngine?: CompletionPolicyEngine;
  readonly owners?: DispatchOwners;
  readonly readBack?: ReadBackExecutor.Options;
  readonly readBackEnvelopeTimeoutMs?: number;
  readonly readBackRecorder?: WorkerCompletionOptions["readBackRecorder"];
  readonly now?: WorkerCompletionOptions["now"];
  /** Gate-side task policy stamping rules (#462 §7); defaults to the built-in required plan. */
  readonly policyResolver?: PolicyResolverInstance;
}

function defaultCompletionAdmissionService(
  options: BuiltInDispatchOptions,
): DispatchCompletionAdmissionService | undefined {
  if (!options.completionWriter) return undefined;
  return createWorkItemCompletionGateway({
    completionWriter: options.completionWriter,
    policyEngine: options.completionPolicyEngine ?? PolicyEngine.create(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function registerBuiltInDispatchHandlers(
  registry: DispatchRegistry,
  options: BuiltInDispatchOptions = {},
): DispatchRegistry {
  const owners = options.owners ?? {};
  const scheduler = owners.scheduler ?? CronJobRegistry;
  const completionService =
    options.completionAdmissionService ?? defaultCompletionAdmissionService(options);
  const handlers = {
    ...createResidentDispatchHandlers({
      residentRuntime: owners.residentRuntime,
      defaultModel: owners.defaultModel,
      ...(owners.ingress === undefined ? {} : { ingress: owners.ingress }),
    }),
    ...createWorkerDispatchHandlers({
      completionService,
      coordinator: owners.coordinator,
      connectorEndpointDriver: owners.connectorEndpointDriver,
      defaultModel: owners.defaultModel,
      readBack: options.readBack,
      readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
      readBackRecorder: options.readBackRecorder,
      now: options.now,
      policyResolver: options.policyResolver,
    }),
    ...createOutboundDispatchHandlers({ outbound: owners.outbound }),
    ...createDeviceDispatchHandlers({ device: owners.device }),
    ...createScheduleDispatchHandlers({ scheduler }),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    registry.register(action, handler);
  }
  return registry;
}

export interface DefaultDispatchRuntimeOptions
  extends DispatchRuntimeOptions,
    BuiltInDispatchOptions {}

type ActorWorkItemCompletionSubmission = Readonly<{
  source: WorkItem.CompletionSourceOrigin & Readonly<{ identity: WorkItem.CompletionIdentity }>;
  request: Omit<WorkItem.CompletionRequest, "origin" | "sourceIdentity">;
  completionReport: WorkItem.CompletionReport;
}>;

export type DefaultDispatchRuntime = DispatchRuntime &
  Readonly<{
    submitActorWorkItemCompletion(
      submission: ActorWorkItemCompletionSubmission,
    ): ReturnType<WorkItemCompletionGateway["requestCompletion"]>;
    recoverRecordedWorkItemCompletions: WorkItemCompletionGateway["recoverRecordedCompletions"];
  }>;

export function createDefaultDispatchRuntime(
  options: DefaultDispatchRuntimeOptions = {},
): DefaultDispatchRuntime {
  const completionService =
    options.completionAdmissionService ?? defaultCompletionAdmissionService(options);
  const runtime = new DispatchRuntime(options);
  registerBuiltInDispatchHandlers(runtime.registry, {
    ...(completionService === undefined ? {} : { completionAdmissionService: completionService }),
    owners: options.owners,
    readBack: options.readBack,
    readBackEnvelopeTimeoutMs: options.readBackEnvelopeTimeoutMs,
    readBackRecorder: options.readBackRecorder,
    now: options.now,
    policyResolver: options.policyResolver,
  });
  return Object.assign(runtime, {
    /**
     * Deliberate api/a2a/human/sdk entry seam per #490; no HTTP surface yet —
     * the server exposes only /health, /observability, /github/webhook.
     */
    submitActorWorkItemCompletion: async (submission: ActorWorkItemCompletionSubmission) => {
      if (!completionService) throw new Error("completion writer is unavailable");
      const source = WorkItem.CompletionSourceOrigin.parse(submission.source);
      if (source.identity === undefined) {
        throw new Error("actor completion source requires caller-authenticated identity");
      }
      return completionService.requestCompletion(
        WorkItem.CompletionRequest.parse({
          ...submission.request,
          origin: WorkItem.projectCompletionOrigin(source),
          sourceIdentity: WorkItem.projectCompletionSourceIdentity(source),
        }),
        submission.completionReport,
      );
    },
    // Closure (not a detached method reference) so an injected service whose
    // recoverRecordedCompletions relies on `this` keeps its receiver.
    recoverRecordedWorkItemCompletions: async () => {
      if (!completionService) throw new Error("completion writer is unavailable");
      if (!completionService.recoverRecordedCompletions) {
        throw new Error("injected completion service does not implement recovery");
      }
      return completionService.recoverRecordedCompletions();
    },
  });
}
