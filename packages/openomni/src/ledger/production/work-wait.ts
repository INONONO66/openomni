import { createHash } from "node:crypto";
import { Execution, Ledger, WorkItem, Wait } from "@openomni/protocol";
import type {
  DurableWaitV1,
  OpenWaitInputV1,
  PinnedWaitRevalidationInputV1,
  PinnedWaitRevalidationV1,
  ResolveWaitCorrelationInput,
  WaitCorrelationCandidate,
  WaitCorrelationResolution,
  WaitKernelService,
  WaitResponseInputV1,
} from "../../ingress/wait-correlation.js";
import type {
  WorkerAttemptLifecycleService,
  WorkerAttemptProjection,
  WorkerAttemptTerminalStatus,
  WorkerDeliveryBindingV1,
  WorkerDeliveryDispositionV1,
} from "../../ingress/handler-worker-run.js";
import type {
  WorkerLedgerBinding,
  WorkerLedgerSemanticCommitResultV1,
  WorkerLedgerSemanticRequestV1,
  WorkerLedgerService,
  WorkerSemanticEffectBindingV1,
} from "../../dispatch/handlers/worker-work-item.js";
import type { AttemptProjectionV1 } from "../reducers/attempt.js";
import type { CompletionProjectionV1 } from "../reducers/completion.js";
import type { WorkProjectionV1 } from "../reducers/work.js";

export type { AttemptProjectionV1, CompletionProjectionV1, WorkProjectionV1 };

export interface WorkAttemptRecordV1 extends WorkerAttemptProjection {
  readonly title: string;
  readonly prompt: string;
  readonly agentName: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly constraints?: readonly string[];
  readonly model: Readonly<{ provider: string; id: string }>;
  readonly environment: Execution.LLMEnvironmentV1;
  readonly error?: string;
  readonly connectorExecutionClaimId?: string;
  readonly deliveryPayload?: string;
  readonly connectorSettlement?:
    | Readonly<{ status: "succeeded"; result: Execution.Result }>
    | Readonly<{ status: "failed"; error: string }>;
  readonly binding?: Readonly<{
    readonly runtimeId: string;
    readonly workerId: string;
    readonly generation: number;
    readonly principalId: string;
    readonly processId: number;
  }>;
}

export interface WorkRecordV1 {
  readonly workItemId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: "draft" | "running" | "failed" | "cancelled" | "completed" | "archived";
  readonly evidenceRefs: readonly string[];
  readonly readbackRefs: readonly string[];
  readonly activeBlockerRefs?: readonly string[];
}

export type CompletionVerdictStatusV1 = "passed" | "failed" | "pending";

/** Durable verifier output. Its artifact digest is the only verdict ref accepted by CP-02. */
export interface CompletionClaimVerdictV1 {
  readonly version: "completion-claim-verdict-v1";
  readonly candidateRef: string;
  readonly candidate: WorkItem.CompletionReport;
  readonly claimIndex: number;
  readonly claimDigest: string;
  readonly evidenceIds: readonly string[];
  readonly status: CompletionVerdictStatusV1;
}

export interface CompletionAdmissionDecisionV1 {
  readonly version: "completion-admission-decision-v1";
  readonly candidate: WorkItem.CompletionReport;
  readonly candidateRef: string;
  readonly verdicts: readonly CompletionClaimVerdictV1[];
  readonly verdictRefs: readonly string[];
  readonly stakesAsOfLedgerSeq: number;
  readonly stakesAsOfDbMs: number;
  readonly admission: Readonly<{
    readonly "AC-1": true;
    readonly "AC-2": true;
    readonly "AC-3": true;
    readonly "AC-4": true;
    readonly "AC-5": true;
    readonly "AC-6": true;
  }>;
}

export interface CompletionRecordV1 {
  readonly workItemId: string;
  readonly status: "candidate" | "rejected" | "admitted";
  readonly candidateRef: string;
  readonly verdictRefs: readonly string[];
  readonly decisionRef: string | null;
  readonly stakesAsOfLedgerSeq: number;
  readonly stakesAsOfDbMs: number;
}

export interface WaitRecordV1 extends DurableWaitV1 {
  readonly workItemId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly sourceRunId?: string;
  readonly targetSessionId?: string;
  readonly payloadDigest?: string;
  readonly responses: readonly WaitResponseRecordV1[];
  readonly ambiguities: readonly Wait.AmbiguityRecordedV1[];
  readonly resolved?: Wait.ResolvedV1;
}

export interface WaitResponseRecordV1 extends Wait.ResponseRecordedV1 {
  readonly eventId: string;
}

export interface EffectRecordV1 {
  readonly effectId: string;
  readonly sourceRef: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly attempt: Ledger.AttemptRefV1;
  readonly settlement: "pending" | "confirmed" | "definite_failed" | "unknown";
  readonly operation:
    | "coordinator.spawn.v1"
    | "coordinator.message.v1"
    | "coordinator.cancel.v1"
    | "worker.credential_provision.v1"
    | "attempt.delivery.v1";
}
type WorkerCoordinatorOperationV1 =
  | "coordinator.spawn.v1"
  | "coordinator.message.v1"
  | "coordinator.cancel.v1";

export type WorkerDispatchContentV1 = Readonly<{
  dispatchId: string;
  sessionId: string;
  runId: string;
  message: string;
}>;

export type WorkerCancelContentV1 = Readonly<{
  dispatchId: string;
  runId: string;
}>;

export type WorkerSettlementContentV1 = Readonly<{
  outcome: "confirmed" | "definite_failed" | "unknown";
}>;

export type WorkerSemanticWorkWaitCommitV1 =
  | Readonly<{
      transitionId: "DP-05";
      requestId: string;
      work: WorkRecordV1;
      attempt: WorkAttemptRecordV1;
      effect: EffectRecordV1;
      effectScope: Execution.EffectScopeV1;
    }>
  | Readonly<{
      transitionId: "DP-07";
      requestId: string;
      work: WorkRecordV1;
      attempt: WorkAttemptRecordV1;
      completion: CompletionRecordV1;
      candidate: WorkItem.CompletionReport;
      evidenceRef: string;
    }>
  | Readonly<{
      transitionId: "DP-09" | "DP-10";
      requestId: string;
      work: WorkRecordV1;
      reason: string;
    }>
  | Readonly<{
      transitionId: "DP-11";
      requestId: string;
      attempt: WorkAttemptRecordV1;
      reason: string;
    }>
  | Readonly<{
      transitionId: "DP-12";
      requestId: string;
      work: WorkRecordV1;
      attempt: WorkAttemptRecordV1;
      dispatch: WorkerDispatchContentV1;
      effect: EffectRecordV1;
      effectScope: Execution.EffectScopeV1;
    }>
  | Readonly<{
      transitionId: "DP-13";
      requestId: string;
      work: WorkRecordV1;
      attempt: WorkAttemptRecordV1;
      wait: WaitRecordV1;
      waitResume: Wait.ResumeRequestedV1;
      dispatch: WorkerDispatchContentV1;
      effect: EffectRecordV1;
      effectScope: Execution.EffectScopeV1;
    }>
  | Readonly<{
      transitionId: "DP-14";
      requestId: string;
      work: WorkRecordV1;
      attempt: WorkAttemptRecordV1;
      dispatch: WorkerCancelContentV1;
      effect: EffectRecordV1;
      effectScope: Execution.EffectScopeV1;
    }>
  | Readonly<{
      transitionId: "WI-06";
      requestId: string;
      work: WorkRecordV1;
      evidenceRef: string;
      evidence: unknown;
    }>
  | Readonly<{
      transitionId: "WI-07";
      requestId: string;
      work: WorkRecordV1;
      attempt: WorkAttemptRecordV1;
      readbackRef: string;
      readback: WorkItem.ReadBackCheck;
    }>
  | Readonly<{
      transitionId: "WI-08";
      requestId: string;
      work: WorkRecordV1;
      blockerRef: string;
      blocker: unknown;
    }>
  | Readonly<{
      transitionId: "CP-02";
      requestId: string;
      completion: CompletionRecordV1;
      verdictRef: string;
      verdict: CompletionClaimVerdictV1;
    }>
  | Readonly<{
      transitionId: "CP-04";
      requestId: string;
      work: WorkRecordV1;
      completion: CompletionRecordV1;
      decisionRef: string;
      decision: CompletionAdmissionDecisionV1;
    }>
  | Readonly<{
      transitionId: "EF-01" | "EF-02" | "EF-03";
      requestId: string;
      work: WorkRecordV1;
      attempt: WorkAttemptRecordV1;
      effect: EffectRecordV1;
      effectScope: Execution.EffectScopeV1;
      settlement: WorkerSettlementContentV1;
    }>;

export interface WorkWaitCommitResultV1 {
  readonly transitionResult: Execution.KernelTransitionResultV1;
  readonly effectBinding?: WorkerSemanticEffectBindingV1;
}

export type WorkWaitCommitV1 =
  | Readonly<{
      transitionId: "DP-05";
      requestId: string;
      work: WorkRecordV1;
      attempt: WorkAttemptRecordV1;
      effect: EffectRecordV1;
    }>
  | Readonly<{
      transitionId: "AT-02" | "AT-03" | "AT-04" | "AT-05" | "AT-08" | "AT-09" | "AT-10" | "AT-11";
      requestId: string;
      attempt: WorkAttemptRecordV1;
      effect?: EffectRecordV1;
    }>
  | Readonly<{
      transitionId: "AT-13";
      requestId: string;
      attempt: WorkAttemptRecordV1;
      effect: EffectRecordV1;
    }>
  | Readonly<{
      transitionId: "AT-12";
      requestId: string;
      attempt: WorkAttemptRecordV1;
      effect: EffectRecordV1;
      effectScope: Execution.EffectScopeV1;
      waitResume: Wait.ResumeRequestedV1;
    }>
  | Readonly<{
      transitionId: "WT-01" | "WT-02" | "WT-03" | "WT-05" | "WT-08";
      requestId: string;
      wait: WaitRecordV1;
      event: Wait.LifecycleEventV1;
      responsePayload?: unknown;
    }>
  | Readonly<{
      transitionId: "DP-15";
      requestId: string;
      wait: WaitRecordV1;
      attempt: WorkAttemptRecordV1;
      dispatchId: string;
    }>
  | WorkerSemanticWorkWaitCommitV1;

/** Closed projection reads needed by Work/Attempt/Wait semantics. */
export interface WorkWaitProjectionPortV1 {
  work(workItemId: string): Promise<WorkRecordV1 | undefined>;
  completion(workItemId: string): Promise<CompletionRecordV1 | undefined>;
  attempt(attemptId: string): Promise<WorkAttemptRecordV1 | undefined>;
  attemptByRunId(runId: string): Promise<WorkAttemptRecordV1 | undefined>;
  attemptsBySession(sessionId: string): Promise<readonly WorkAttemptRecordV1[]>;
  wait(waitId: string): Promise<WaitRecordV1 | undefined>;
  waitCandidates(endpointId?: string, channelId?: string): Promise<readonly WaitRecordV1[]>;
  waitsByAttempt(attemptId: string): Promise<readonly WaitRecordV1[]>;
  effect(effectId: string): Promise<EffectRecordV1 | undefined>;
}

/** Closed atomic transition face; it cannot append arbitrary events or query storage. */
export interface WorkWaitTransitionPortV1 {
  commit(command: WorkWaitCommitV1): Promise<WorkWaitCommitResultV1>;
}

export interface WorkWaitProductionConfigV1 {
  readonly model: Readonly<{ provider: string; id: string }>;
  readonly modelEnvironment: Execution.LLMEnvironmentV1;
  readonly now?: () => number;
  readonly workerEffectScope: (
    sourceRef: string,
    operation: "coordinator.spawn.v1" | "coordinator.message.v1" | "coordinator.cancel.v1",
  ) => Execution.EffectScopeV1;
}

export interface ResidentAskInputV1 {
  readonly requestId: string;
  readonly sourceSessionId: string;
  readonly sourceRunId: string;
  readonly targetSessionId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly payload: string;
}

export interface ResidentAskReceiptV1 {
  readonly waitId: string;
  readonly correlation: Readonly<{ endpointId: string; channelId: string; tokenHash: string }>;
}
export interface OpenProductionWaitInputV1 extends OpenWaitInputV1 {
  readonly quorum?: Wait.QuorumV1;
  readonly deadline?: number;
  readonly resolutionPolicy?: "first-response" | "quorum";
  readonly followUpWindow?: number;
  readonly attempt: Ledger.AttemptRefV1;
  readonly sessionId: string;
}

export interface WorkWaitKernelService extends Omit<WaitKernelService, "open"> {
  open(input: OpenProductionWaitInputV1): Promise<DurableWaitV1>;
}

export interface MessagingWaitLifecycle {
  readonly queries: {
    attemptByExecution(
      input: Readonly<{ sessionId: string; runId: string }>,
    ): Promise<WorkerAttemptProjection | undefined>;
  };
  readonly commands: {
    openResidentAsk(input: ResidentAskInputV1): Promise<ResidentAskReceiptV1>;
    resumeAfterResolvedWait(waitId: string): Promise<WorkerDeliveryDispositionV1>;
    cancel(waitId: string, reason: string): Promise<void>;
  };
}

export interface WorkCompletionQueryServiceV1 {
  work(workItemId: string): Promise<WorkRecordV1 | undefined>;
  completion(workItemId: string): Promise<CompletionRecordV1 | undefined>;
}

export interface WorkerRuntimeAttemptQueryV1 {
  byExecution(
    input: Readonly<{ sessionId: string; runId: string }>,
  ): Promise<WorkAttemptRecordV1 | undefined>;
}

export interface WorkWaitServicesV1 {
  readonly workerAttempts: WorkerAttemptLifecycleService;
  readonly waitKernel: WorkWaitKernelService;
  readonly messagingWaitLifecycle: MessagingWaitLifecycle;
  readonly workCompletion: WorkCompletionQueryServiceV1;
  readonly workerLedger: WorkerLedgerService;
  readonly runtimeAttempts: WorkerRuntimeAttemptQueryV1;
}

const TERMINAL = new Set<WorkerAttemptProjection["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export function createWorkWaitServices(
  projections: WorkWaitProjectionPortV1,
  transitions: WorkWaitTransitionPortV1,
  config: WorkWaitProductionConfigV1,
): WorkWaitServicesV1 {
  const now = config.now ?? Date.now;
  const workerAttempts = createWorkerAttemptService(projections, transitions, config);
  const workerLedger = createWorkerLedgerService(projections, transitions, config);
  const waitKernel = createWaitService(projections, transitions, now);
  return Object.freeze({
    workerAttempts,
    workerLedger,
    waitKernel,
    messagingWaitLifecycle: createMessagingWaitLifecycle(
      projections,
      transitions,
      waitKernel,
      now,
      config,
    ),
    workCompletion: Object.freeze({
      work: (workItemId: string) => projections.work(workItemId),
      completion: (workItemId: string) => projections.completion(workItemId),
    }),
    runtimeAttempts: Object.freeze({
      async byExecution(input: Readonly<{ sessionId: string; runId: string }>) {
        const attempt = await projections.attemptByRunId(input.runId);
        return attempt?.sessionId === input.sessionId ? attempt : undefined;
      },
    }),
  });
}
function createWorkerLedgerService(
  projections: WorkWaitProjectionPortV1,
  transitions: WorkWaitTransitionPortV1,
  config: WorkWaitProductionConfigV1,
): WorkerLedgerService {
  const rejected = (
    code: "identity_mismatch" | "idempotency_mismatch",
  ): WorkerLedgerSemanticCommitResultV1 => ({
    transitionResult: { version: "kernel-transition-result-v1", status: "rejected", code },
  });
  const bindingFor = async (runId: string): Promise<WorkerLedgerBinding | undefined> => {
    const attempt = await projections.attemptByRunId(runId);
    if (attempt === undefined) return undefined;
    const work = await projections.work(attempt.workItemId);
    if (work === undefined) return undefined;
    return Object.freeze<WorkerLedgerBinding>({
      owner: Ledger.OwnerV1.parse({
        version: "ledger-owner-v1",
        ownerKey: `work:${work.workItemId}`,
      }),
      workItemId: work.workItemId,
      runId: attempt.runId,
      attempt: attemptRef(attempt),
      status: work.status,
      evidenceRefs: Object.freeze([...work.evidenceRefs]),
      readbackRefs: Object.freeze([...work.readbackRefs]),
    });
  };
  return Object.freeze({
    resolveWorkByRunId: bindingFor,
    resolveAttemptByRunId: bindingFor,
    async commitSemanticTransition(request: WorkerLedgerSemanticRequestV1) {
      if (request.requestHash !== workerRequestHash(request))
        return rejected("idempotency_mismatch");
      const bound = await bindingFor(request.target.runId);
      if (request.transitionId !== "DP-05" && !sameValue(bound, request.target))
        return rejected("identity_mismatch");
      const attempt = await projections.attemptByRunId(request.target.runId);
      const work = await projections.work(request.target.workItemId);
      switch (request.transitionId) {
        case "DP-05":
          return commitWorkerSpawn(request, work, attempt, bound, transitions, config, rejected);
        case "DP-07": {
          const currentWork = requireSemantic(work);
          const currentAttempt = requireSemantic(attempt);
          const candidate = WorkItem.CompletionReport.parse(request.content);
          if (
            request.evidenceRef !== sha256(canonicalJson(candidate)) ||
            candidate.claims.some((claim) =>
              claim.evidenceIds.some(
                (ref) =>
                  !currentWork.evidenceRefs.includes(ref) &&
                  !currentWork.readbackRefs.includes(ref),
              ),
            )
          ) {
            return rejected("identity_mismatch");
          }
          return transitions.commit({
            transitionId: "DP-07",
            requestId: request.requestId,
            work: currentWork,
            attempt: { ...currentAttempt, status: "succeeded" },
            candidate,
            evidenceRef: request.evidenceRef,
            completion: {
              workItemId: currentWork.workItemId,
              status: "candidate",
              candidateRef: request.evidenceRef,
              verdictRefs: [],
              decisionRef: null,
              stakesAsOfLedgerSeq: 0,
              stakesAsOfDbMs: config.now?.() ?? Date.now(),
            },
          });
        }
        case "DP-09":
        case "DP-10": {
          const currentWork = requireSemantic(work);
          const content = semanticRecord(request.content);
          const reason =
            semanticOptionalString(content, "reason") ?? semanticString(content, "status");
          return transitions.commit({
            transitionId: request.transitionId,
            requestId: request.requestId,
            reason,
            work: {
              ...currentWork,
              status: request.transitionId === "DP-09" ? "cancelled" : "failed",
            },
          });
        }
        case "DP-11": {
          const currentAttempt = requireSemantic(attempt);
          const reason = semanticString(semanticRecord(request.content), "reason");
          return transitions.commit({
            transitionId: "DP-11",
            requestId: request.requestId,
            reason,
            attempt: { ...currentAttempt, status: "interrupted", error: reason },
          });
        }
        case "DP-12":
        case "DP-13":
        case "DP-14":
          return commitWorkerControl(
            request.transitionId,
            request,
            requireSemantic(work),
            requireSemantic(attempt),
            transitions,
            projections,
            config,
            rejected,
          );
        case "WI-06":
        case "WI-08": {
          const currentWork = requireSemantic(work);
          if (
            request.evidenceRef === undefined ||
            request.evidenceRef !== sha256(canonicalJson(request.content))
          )
            return rejected("identity_mismatch");
          const existingRefs =
            request.transitionId === "WI-06"
              ? currentWork.evidenceRefs
              : (currentWork.activeBlockerRefs ?? []);
          if (existingRefs.includes(request.evidenceRef)) return rejected("idempotency_mismatch");
          if (request.transitionId === "WI-06") {
            return transitions.commit({
              transitionId: "WI-06",
              requestId: request.requestId,
              work: {
                ...currentWork,
                evidenceRefs: Object.freeze([...currentWork.evidenceRefs, request.evidenceRef]),
              },
              evidenceRef: request.evidenceRef,
              evidence: request.content,
            });
          }
          return transitions.commit({
            transitionId: "WI-08",
            requestId: request.requestId,
            work: {
              ...currentWork,
              activeBlockerRefs: Object.freeze([...existingRefs, request.evidenceRef]),
            },
            blockerRef: request.evidenceRef,
            blocker: request.content,
          });
        }
        case "WI-07": {
          const currentWork = requireSemantic(work);
          const currentAttempt = requireSemantic(attempt);
          const readback = WorkItem.ReadBackCheck.parse(request.content);
          if (
            request.evidenceRef === undefined ||
            request.evidenceRef !== sha256(canonicalJson(readback)) ||
            currentAttempt.workItemId !== currentWork.workItemId ||
            currentAttempt.sessionId !== currentWork.sessionId ||
            !sameValue(attemptRef(currentAttempt), request.target.attempt) ||
            request.target.runId !== currentAttempt.runId
          )
            return rejected("identity_mismatch");
          if (currentWork.readbackRefs.includes(request.evidenceRef))
            return rejected("idempotency_mismatch");
          return transitions.commit({
            transitionId: "WI-07",
            requestId: request.requestId,
            work: {
              ...currentWork,
              readbackRefs: Object.freeze([...currentWork.readbackRefs, request.evidenceRef]),
            },
            attempt: currentAttempt,
            readbackRef: request.evidenceRef,
            readback,
          });
        }
        case "CP-02": {
          const completion = requireSemantic(
            await projections.completion(request.target.workItemId),
          );
          const verdict = parseCompletionVerdict(request.content);
          if (
            request.evidenceRef === undefined ||
            request.evidenceRef !== sha256(canonicalJson(verdict)) ||
            sha256(canonicalJson(verdict.candidate)) !== completion.candidateRef ||
            !completionVerdictBindsClaim(verdict) ||
            verdict.candidateRef !== completion.candidateRef ||
            completion.status !== "candidate" ||
            completion.verdictRefs.includes(request.evidenceRef)
          )
            return rejected("identity_mismatch");
          return transitions.commit({
            transitionId: "CP-02",
            requestId: request.requestId,
            verdictRef: request.evidenceRef,
            verdict,
            completion: {
              ...completion,
              verdictRefs: Object.freeze([...completion.verdictRefs, request.evidenceRef]),
            },
          });
        }
        case "CP-04": {
          const currentWork = requireSemantic(work);
          const completion = requireSemantic(
            await projections.completion(request.target.workItemId),
          );
          const decision = parseCompletionAdmissionDecision(request.content);
          if (
            request.evidenceRef === undefined ||
            request.evidenceRef !== sha256(canonicalJson(decision)) ||
            completion.status !== "candidate" ||
            !completionAdmissionIsExact(currentWork, completion, decision)
          )
            return rejected("identity_mismatch");
          return transitions.commit({
            transitionId: "CP-04",
            requestId: request.requestId,
            decisionRef: request.evidenceRef,
            decision,
            work: { ...currentWork, status: "completed" },
            completion: { ...completion, status: "admitted", decisionRef: request.evidenceRef },
          });
        }
        case "EF-01":
        case "EF-02":
        case "EF-03": {
          const currentWork = requireSemantic(work);
          const currentAttempt = requireSemantic(attempt);
          const supplied = requireSemantic(request.effectBinding);
          const projectedEffect = await projections.effect(supplied.effect.effectId);
          if (projectedEffect === undefined) return rejected("identity_mismatch");
          const effect = projectedEffect;
          if (
            effect.settlement !== "pending" ||
            effect.sourceRef !== supplied.effect.idempotencyKey ||
            !sameValue(effect.attempt, request.target.attempt)
          )
            return rejected("identity_mismatch");
          const operation = workerCoordinatorOperation(effect.operation);
          if (
            !sameValue(config.workerEffectScope(effect.sourceRef, operation), supplied.effectScope)
          )
            return rejected("identity_mismatch");
          const outcome = semanticString(semanticRecord(request.content), "outcome");
          const expected =
            request.transitionId === "EF-01"
              ? "confirmed"
              : request.transitionId === "EF-02"
                ? "definite_failed"
                : "unknown";
          if (outcome !== expected) return rejected("identity_mismatch");
          return transitions.commit({
            transitionId: request.transitionId,
            requestId: request.requestId,
            work: currentWork,
            attempt: currentAttempt,
            effect: { ...effect, settlement: expected },
            effectScope: supplied.effectScope,
            settlement: { outcome: expected },
          });
        }
        default:
          return rejected("identity_mismatch");
      }
    },
  });
}

async function commitWorkerSpawn(
  request: WorkerLedgerSemanticRequestV1,
  work: WorkRecordV1 | undefined,
  attempt: WorkAttemptRecordV1 | undefined,
  bound: WorkerLedgerBinding | undefined,
  transitions: WorkWaitTransitionPortV1,
  config: WorkWaitProductionConfigV1,
  rejected: (code: "identity_mismatch") => WorkerLedgerSemanticCommitResultV1,
): Promise<WorkerLedgerSemanticCommitResultV1> {
  if (bound !== undefined && !sameValue(bound, request.target))
    return rejected("identity_mismatch");
  const content = semanticRecord(request.content);
  const sessionId = semanticString(content, "sessionId");
  const title = semanticString(content, "name");
  const acceptanceCriteria = semanticStringArray(content, "acceptanceCriteria");
  const constraints = semanticOptionalStringArray(content, "constraints");
  const createdWork = work ?? {
    workItemId: request.target.workItemId,
    sessionId,
    title,
    status: "draft" as const,
    evidenceRefs: [],
    readbackRefs: [],
  };
  const createdAttempt = attempt ?? {
    workItemId: request.target.workItemId,
    attemptId: request.target.attempt.attemptId,
    attemptSeq: request.target.attempt.attemptSeq,
    sessionId,
    runId: request.target.runId,
    status: "allocated" as const,
    title,
    prompt: semanticString(content, "goal"),
    agentName: semanticOptionalString(content, "assigneeId") ?? "worker",
    acceptanceCriteria,
    ...(constraints === undefined ? {} : { constraints }),
    model: config.model,
    environment: Execution.LLMEnvironmentV1.parse(config.modelEnvironment),
  };
  if (
    createdWork.sessionId !== sessionId ||
    createdAttempt.runId !== request.target.runId ||
    !sameValue(createdAttempt.acceptanceCriteria ?? [], acceptanceCriteria) ||
    !sameValue(createdAttempt.constraints ?? [], constraints ?? [])
  )
    return rejected("identity_mismatch");
  const effect = workerEffect(createdAttempt, request.requestId, "coordinator.spawn.v1");
  const effectScope = config.workerEffectScope(request.requestId, "coordinator.spawn.v1");
  return transitions.commit({
    transitionId: "DP-05",
    requestId: request.requestId,
    work: createdWork,
    attempt: createdAttempt,
    effect,
    effectScope,
  });
}

async function commitWorkerControl(
  transitionId: "DP-12" | "DP-13" | "DP-14",
  request: WorkerLedgerSemanticRequestV1,
  work: WorkRecordV1,
  attempt: WorkAttemptRecordV1,
  transitions: WorkWaitTransitionPortV1,
  projections: WorkWaitProjectionPortV1,
  config: WorkWaitProductionConfigV1,
  rejected: (code: "identity_mismatch") => WorkerLedgerSemanticCommitResultV1,
): Promise<WorkerLedgerSemanticCommitResultV1> {
  const content = semanticRecord(request.content);
  const dispatchId = semanticString(content, "dispatchId");
  const runId = semanticString(content, "runId");
  if (dispatchId !== request.requestId || runId !== attempt.runId)
    return rejected("identity_mismatch");
  const operation = transitionId === "DP-14" ? "coordinator.cancel.v1" : "coordinator.message.v1";
  const effect = workerEffect(attempt, request.requestId, operation);
  const effectScope = config.workerEffectScope(request.requestId, operation);
  if (transitionId === "DP-14")
    return transitions.commit({
      transitionId: "DP-14",
      requestId: request.requestId,
      work,
      attempt,
      dispatch: { dispatchId, runId },
      effect,
      effectScope,
    });
  const sessionId = semanticString(content, "sessionId");
  if (sessionId !== attempt.sessionId) return rejected("identity_mismatch");
  const dispatch = { dispatchId, sessionId, runId, message: semanticString(content, "message") };
  if (transitionId === "DP-13") {
    const resolvedWaits = (await projections.waitsByAttempt(attempt.attemptId)).filter(
      (wait) => wait.status === "resolved",
    );
    const wait = resolvedWaits.length === 1 ? resolvedWaits[0] : undefined;
    if (wait === undefined) return rejected("identity_mismatch");
    const waitResume = Wait.ResumeRequestedV1.parse({
      version: "wait.resume_requested.v1",
      waitId: wait.waitId,
      ownerRef: wait.opened.ownerRef,
      attempt: attemptRef(attempt),
      responseEventIds: wait.responses.map(({ eventId }) => eventId),
      requestedAtDbMs: config.now?.() ?? Date.now(),
    });
    return transitions.commit({
      transitionId,
      requestId: request.requestId,
      work,
      attempt,
      wait,
      waitResume,
      dispatch,
      effect,
      effectScope,
    });
  }
  return transitions.commit({
    transitionId,
    requestId: request.requestId,
    work,
    attempt,
    dispatch,
    effect,
    effectScope,
  });
}

function workerEffect<Operation extends WorkerCoordinatorOperationV1>(
  attempt: WorkAttemptRecordV1,
  sourceRef: string,
  operation: Operation,
): EffectRecordV1 & Readonly<{ operation: Operation }> {
  return {
    effectId: `worker-effect:${sha256(`${operation}\0${sourceRef}`)}`,
    sourceRef,
    workItemId: attempt.workItemId,
    attemptId: attempt.attemptId,
    attempt: attemptRef(attempt),
    settlement: "pending",
    operation,
  };
}

function workerCoordinatorOperation(
  operation: EffectRecordV1["operation"],
): WorkerCoordinatorOperationV1 {
  switch (operation) {
    case "coordinator.spawn.v1":
    case "coordinator.message.v1":
    case "coordinator.cancel.v1":
      return operation;
    case "worker.credential_provision.v1":
    case "attempt.delivery.v1":
      throw new TypeError("worker effect operation is malformed");
  }
}

function workerRequestHash(request: WorkerLedgerSemanticRequestV1): string {
  return sha256(
    canonicalJson({
      transitionId: request.transitionId,
      target: {
        owner: request.target.owner,
        workItemId: request.target.workItemId,
        runId: request.target.runId,
        attempt: request.target.attempt,
      },
      evidenceRef: request.evidenceRef,
      content: request.content,
      effectBinding: request.effectBinding,
    }),
  );
}

function semanticRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isSemanticRecord(value)) throw new TypeError("semantic content is malformed");
  return value;
}

function isSemanticRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function semanticString(value: Readonly<Record<string, unknown>>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0)
    throw new TypeError(`${field} is required`);
  return result;
}
function semanticOptionalString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const result = value[field];
  if (result === undefined) return undefined;
  if (typeof result !== "string") throw new TypeError(`${field} is malformed`);
  return result;
}
function semanticStringArray(
  value: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] {
  const result = value[field];
  if (!Array.isArray(result) || !result.every((item) => typeof item === "string"))
    throw new TypeError(`${field} is malformed`);
  return Object.freeze([...result]);
}
function semanticOptionalStringArray(
  value: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] | undefined {
  return value[field] === undefined ? undefined : semanticStringArray(value, field);
}
function requireSemantic<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required semantic projection is missing");
  return value;
}
function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function createWorkerAttemptService(
  projections: WorkWaitProjectionPortV1,
  transitions: WorkWaitTransitionPortV1,
  config: WorkWaitProductionConfigV1,
): WorkerAttemptLifecycleService {
  const transition = async (
    claimed: WorkerAttemptProjection,
    transitionId: "AT-02" | "AT-03" | "AT-04" | "AT-05" | "AT-08" | "AT-09" | "AT-10" | "AT-11",
    status: WorkAttemptRecordV1["status"],
    additions: Readonly<{ error?: string; deliveryPayload?: string }> = {},
  ): Promise<void> => {
    const current = await requireAttempt(projections, claimed);
    const attempt: WorkAttemptRecordV1 = { ...current, ...additions, status };
    const effect = effectForAttemptTransition(current, transitionId);
    const committed = await transitions.commit({
      transitionId,
      requestId: `attempt:${transitionId}:${current.attemptId}`,
      attempt,
      ...(effect === undefined ? {} : { effect }),
    });
    requireCommitted(committed, `Attempt ${transitionId}`);
  };
  const requestDelivery = async (input: {
    readonly attempt: WorkerAttemptProjection;
    readonly deliveryId: string;
    readonly payload: string;
  }): Promise<WorkerDeliveryDispositionV1> => {
    if (!input.deliveryId) throw new TypeError("Worker delivery requires an immutable delivery ID");
    const current = await requireAttempt(projections, input.attempt);
    if (current.status !== "running") {
      throw new Error("Direct Worker delivery requires a running Attempt");
    }
    const work = requireValue(
      await projections.work(current.workItemId),
      "Direct Worker delivery requires its authoritative WorkItem",
    );
    const sourceRef = `ingress-delivery:${input.deliveryId}`;
    const effect = workerEffect(current, sourceRef, "coordinator.message.v1");
    const effectScope = config.workerEffectScope(sourceRef, "coordinator.message.v1");
    const existing = await projections.effect(effect.effectId);
    if (existing !== undefined) {
      requireExactReplayEffect(existing, effect, "Direct Worker delivery");
      return deliveryReplayDisposition(existing, effectScope);
    }
    const committed = await transitions.commit({
      transitionId: "DP-12",
      requestId: sourceRef,
      work,
      attempt: current,
      dispatch: {
        dispatchId: sourceRef,
        sessionId: current.sessionId,
        runId: current.runId,
        message: input.payload,
      },
      effect,
      effectScope,
    });
    requireCommitted(committed, "Direct Worker delivery intent");
    const binding = requireValue(
      committed.effectBinding,
      "Direct Worker delivery committed without an exact effect binding",
    );
    requireExactEffectBinding(binding, effect, effectScope, "Direct Worker delivery");
    return Object.freeze({ disposition: "act", delivery: binding });
  };
  const settleDelivery = async (input: {
    readonly attempt: WorkerAttemptProjection;
    readonly delivery: WorkerDeliveryBindingV1;
    readonly accepted: boolean;
  }): Promise<void> => {
    const current = await requireAttempt(projections, input.attempt);
    const authoritativeEffect = requireValue(
      await projections.effect(input.delivery.effect.effectId),
      "Attempt delivery settlement requires its authoritative effect",
    );
    const expectedOperation = "coordinator.message.v1" as const;
    const expectedScope = config.workerEffectScope(
      authoritativeEffect.sourceRef,
      expectedOperation,
    );
    requireExactEffectBinding(
      input.delivery,
      authoritativeEffect,
      expectedScope,
      "Attempt delivery",
    );
    if (
      authoritativeEffect.workItemId !== current.workItemId ||
      authoritativeEffect.attemptId !== current.attemptId ||
      !sameValue(authoritativeEffect.attempt, attemptRef(current)) ||
      authoritativeEffect.operation !== expectedOperation ||
      authoritativeEffect.settlement !== "pending"
    ) {
      throw new Error("Authoritative Attempt delivery effect does not match the current Attempt");
    }
    const settlement = input.accepted ? "confirmed" : "definite_failed";
    if (current.status === "waiting") {
      const transitionId = input.accepted ? "AT-03" : "AT-13";
      const committed = await transitions.commit({
        transitionId,
        requestId: `${authoritativeEffect.sourceRef}:settlement`,
        attempt: { ...current, status: input.accepted ? "running" : "failed" },
        effect: { ...authoritativeEffect, settlement },
      });
      requireCommitted(committed, `Attempt delivery ${transitionId}`);
      return;
    }
    if (current.status !== "running") {
      throw new Error("Direct Worker delivery settlement requires a running Attempt");
    }
    const work = requireValue(
      await projections.work(current.workItemId),
      "Direct Worker delivery settlement requires its authoritative WorkItem",
    );
    const transitionId = input.accepted ? "EF-01" : "EF-02";
    const committed = await transitions.commit({
      transitionId,
      requestId: `${authoritativeEffect.sourceRef}:settlement`,
      work,
      attempt: current,
      effect: { ...authoritativeEffect, settlement },
      effectScope: expectedScope,
      settlement: { outcome: settlement },
    });
    requireCommitted(committed, `Direct Worker delivery ${transitionId}`);
  };

  return Object.freeze({
    commands: Object.freeze({
      requestStart: (attempt: WorkerAttemptProjection) => transition(attempt, "AT-02", "starting"),
      finish: (input: {
        readonly attempt: WorkerAttemptProjection;
        readonly status: WorkerAttemptTerminalStatus;
        readonly error?: string;
      }) =>
        transition(
          input.attempt,
          terminalTransition(input.status),
          input.status,
          input.error === undefined ? {} : { error: input.error },
        ),
      requestDelivery,
      settleDelivery,
      requestCancel: (attempt: WorkerAttemptProjection) =>
        transition(attempt, "AT-10", "cancelled"),
      settleCancel: (input: {
        readonly attempt: WorkerAttemptProjection;
        readonly cancelled: boolean;
      }) =>
        transition(
          input.attempt,
          input.cancelled ? "AT-05" : "AT-03",
          input.cancelled ? "cancelled" : "running",
        ),
    }),
    queries: Object.freeze({
      async byExecution(input: { readonly sessionId: string; readonly runId: string }) {
        const { sessionId, runId } = input;
        const attempt = await projections.attemptByRunId(runId);
        if (attempt === undefined) return undefined;
        return attempt.sessionId === sessionId ? attempt : undefined;
      },
      async active(input: { readonly sessionId: string; readonly runId?: string }) {
        const { sessionId, runId } = input;
        const attempts = await projections.attemptsBySession(sessionId);
        return attempts.filter(
          (attempt) =>
            (runId === undefined || attempt.runId === runId) && !TERMINAL.has(attempt.status),
        );
      },
    }),
  });
}

function requireCommitted(result: WorkWaitCommitResultV1, operation: string): void {
  if (result.transitionResult.status !== "committed") {
    throw new Error(`${operation} rejected: ${result.transitionResult.code}`);
  }
}

function requireExactEffectBinding(
  binding: WorkerDeliveryBindingV1,
  effect: EffectRecordV1,
  effectScope: Execution.EffectScopeV1,
  operation: string,
): void {
  if (
    binding.effect.effectId !== effect.effectId ||
    binding.effect.idempotencyKey !== effect.sourceRef ||
    !sameValue(binding.effectScope, effectScope)
  ) {
    throw new Error(`${operation} effect binding does not match the immutable action boundary`);
  }
}

function requireExactReplayEffect(
  existing: EffectRecordV1,
  expected: EffectRecordV1,
  operation: string,
): void {
  if (
    existing.effectId !== expected.effectId ||
    existing.sourceRef !== expected.sourceRef ||
    existing.workItemId !== expected.workItemId ||
    existing.attemptId !== expected.attemptId ||
    !sameValue(existing.attempt, expected.attempt) ||
    existing.operation !== expected.operation
  ) {
    throw new Error(`${operation} replay has a conflicting immutable effect binding`);
  }
}

function deliveryReplayDisposition(
  effect: EffectRecordV1,
  effectScope: Execution.EffectScopeV1,
): WorkerDeliveryDispositionV1 {
  const delivery = Object.freeze({
    effect: Ledger.EffectRefV1.parse({
      version: "effect-ref-v1",
      effectId: effect.effectId,
      idempotencyKey: effect.sourceRef,
    }),
    effectScope,
  });
  return effect.settlement === "pending" || effect.settlement === "unknown"
    ? Object.freeze({ disposition: "reconcile", delivery, outcome: effect.settlement })
    : Object.freeze({ disposition: "terminal", delivery, outcome: effect.settlement });
}

async function requireWaitOpenBindings(
  projections: WorkWaitProjectionPortV1,
  input: OpenProductionWaitInputV1,
): Promise<Readonly<{ work: WorkRecordV1; attempt: WorkAttemptRecordV1 }>> {
  if (
    input.ownerRef.kind !== "workItem" ||
    input.ownerRef.id !== input.attempt.workItemId ||
    !input.sessionId
  ) {
    throw new Error("Wait open requires exact WorkItem owner, Attempt, and session bindings");
  }
  const work = requireValue(
    await projections.work(input.attempt.workItemId),
    "Wait open requires an authoritative WorkItem",
  );
  const attempt = await requireAttemptRef(projections, input.attempt);
  if (
    work.workItemId !== input.attempt.workItemId ||
    work.sessionId !== input.sessionId ||
    attempt.workItemId !== work.workItemId ||
    attempt.sessionId !== input.sessionId
  ) {
    throw new Error("Wait open authoritative WorkItem, Attempt, and session bindings conflict");
  }
  return { work, attempt };
}

function requireExactWaitOpen(existing: WaitRecordV1, input: OpenProductionWaitInputV1): void {
  const quorum =
    input.quorum ??
    Wait.QuorumV1.parse({
      version: "wait-quorum-v1",
      required: 1,
      total: input.expectedResponders.length,
    });
  const resolutionPolicy =
    input.resolutionPolicy ?? (quorum.required === 1 ? "first-response" : "quorum");
  if (
    existing.waitId !== input.waitId ||
    existing.workItemId !== input.attempt.workItemId ||
    existing.attemptId !== input.attempt.attemptId ||
    existing.sessionId !== input.sessionId ||
    !sameValue(existing.opened.ownerRef, input.ownerRef) ||
    !sameValue(existing.opened.attempt, input.attempt) ||
    !sameValue(existing.opened.expectedResponders, input.expectedResponders) ||
    !sameValue(existing.opened.correlation, input.correlation) ||
    !sameValue(existing.opened.allowedActions, input.allowedActions) ||
    !sameValue(existing.route, input.route) ||
    existing.opened.targetActorId !== input.targetActorId ||
    existing.opened.endpointId !== input.endpointId ||
    existing.opened.channelId !== input.channelId ||
    existing.opened.resolutionPolicy !== resolutionPolicy ||
    !sameValue(existing.opened.quorum, quorum) ||
    existing.opened.followUpWindow !== (input.followUpWindow ?? 0) ||
    (input.deadline !== undefined && existing.opened.deadline !== input.deadline)
  ) {
    throw new Error("Wait ID is bound to different immutable open bindings");
  }
}

function createWaitService(
  projections: WorkWaitProjectionPortV1,
  transitions: WorkWaitTransitionPortV1,
  now: () => number,
): WorkWaitKernelService {
  const acceptResponse = async (input: WaitResponseInputV1): Promise<WaitRecordV1> => {
    const current = requireValue(
      await projections.wait(input.waitId),
      `Wait not found: ${input.waitId}`,
    );
    const responseHash = sha256(canonicalJson(input.payload));
    const duplicate = current.responses.find(
      (response) => response.transportId === input.transportId,
    );
    if (duplicate !== undefined) {
      if (
        duplicate.responseHash !== responseHash ||
        duplicate.action !== input.action ||
        !sameResponder(duplicate.responder, input.responder)
      ) {
        throw new Error("Wait transport duplicate conflicts with its recorded response");
      }
      return current;
    }
    if (current.status !== "open") throw new Error(`Wait is not open: ${input.waitId}`);
    if (!current.opened.allowedActions.includes(input.action))
      throw new Error("Wait action is not allowed");
    if (
      !current.opened.expectedResponders.some((candidate) =>
        sameResponder(candidate, input.responder),
      )
    ) {
      throw new Error("Wait responder is not expected");
    }
    if (current.responses.some((response) => sameResponder(response.responder, input.responder))) {
      throw new Error("Wait responder has already supplied its quorum response");
    }
    const recordedAtDbMs = now();
    if (recordedAtDbMs > current.opened.deadline) throw new Error("Wait response is late");
    const transitionId =
      current.responses.length + 1 >= current.opened.quorum.required ? "WT-03" : "WT-02";
    const eventId = `wait:response:${input.transportId}:${transitionId}:1`;
    const response = Wait.ResponseRecordedV1.parse({
      version: "wait.response_recorded.v1",
      waitId: input.waitId,
      ownerRef: current.opened.ownerRef,
      responder: input.responder,
      transportId: input.transportId,
      responseHash,
      action: input.action,
      payloadRef: `sha256:${responseHash}`,
      recordedAtDbMs,
    });
    const responses = [...current.responses, { ...response, eventId }];
    const resolved =
      transitionId === "WT-03"
        ? Wait.ResolvedV1.parse({
            version: "wait.resolved.v1",
            waitId: input.waitId,
            ownerRef: current.opened.ownerRef,
            responseEventIds: responses.map((item) => item.eventId),
            quorum: current.opened.quorum,
            partial: false,
            resolvedAtDbMs: recordedAtDbMs,
          })
        : undefined;
    const state: WaitRecordV1 = {
      ...current,
      responses,
      ...(resolved === undefined
        ? {}
        : {
            status: "resolved",
            resolved,
            resolvedAtDbMs: recordedAtDbMs,
            routingDeadlineDbMs: recordedAtDbMs + 30_000,
            routedDispatchId: `wait:${input.waitId}:threshold`,
            routedAction: input.action,
          }),
    };
    const commit = await transitions.commit({
      transitionId,
      requestId: `wait:response:${input.transportId}`,
      wait: state,
      event: resolved ?? response,
      responsePayload: input.payload,
    });
    if (commit.transitionResult.status !== "committed")
      throw new Error(`Wait transition rejected: ${commit.transitionResult.code}`);
    return state;
  };

  return Object.freeze({
    async open(input: OpenProductionWaitInputV1) {
      const authoritative = await requireWaitOpenBindings(projections, input);
      const existing = await projections.wait(input.waitId);
      if (existing !== undefined) {
        requireExactWaitOpen(existing, input);
        return existing;
      }
      const openedAt = now();
      const extended = input;
      const quorum =
        extended.quorum ??
        Wait.QuorumV1.parse({
          version: "wait-quorum-v1",
          required: 1,
          total: input.expectedResponders.length,
        });
      if (
        quorum.total !== input.expectedResponders.length ||
        quorum.required < 1 ||
        quorum.required > quorum.total
      ) {
        throw new TypeError("Wait quorum must be satisfiable by the expected responders");
      }
      const deadline = extended.deadline ?? openedAt + 300_000;
      if (deadline <= openedAt || deadline > openedAt + 86_400_000) {
        throw new TypeError("Wait deadline must be within the next 24 hours");
      }
      const resolutionPolicy =
        extended.resolutionPolicy ?? (quorum.required === 1 ? "first-response" : "quorum");
      if ((resolutionPolicy === "first-response") !== (quorum.required === 1)) {
        throw new TypeError("Wait resolution policy and quorum are inconsistent");
      }
      const opened = Wait.OpenedV1.parse({
        version: "wait.opened.v1",
        waitId: input.waitId,
        ownerRef: input.ownerRef,
        expectedResponders: input.expectedResponders,
        ...(input.targetActorId === undefined ? {} : { targetActorId: input.targetActorId }),
        ...(input.endpointId === undefined ? {} : { endpointId: input.endpointId }),
        ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
        correlation: input.correlation,
        allowedActions: input.allowedActions,
        resolutionPolicy,
        quorum,
        status: "open",
        deadline,
        partial: false,
        followUpWindow: extended.followUpWindow ?? 0,
        ...(extended.attempt === undefined ? {} : { attempt: extended.attempt }),
      });
      const state: WaitRecordV1 = {
        waitId: input.waitId,
        revision: "1",
        opened,
        status: "open",
        route: input.route,
        workItemId: authoritative.work.workItemId,
        attemptId: authoritative.attempt.attemptId,
        sessionId: authoritative.attempt.sessionId,
        responses: [],
        ambiguities: [],
      };
      const commit = await transitions.commit({
        transitionId: "WT-01",
        requestId: `wait:open:${input.waitId}`,
        wait: state,
        event: opened,
      });
      if (commit.transitionResult.status !== "committed")
        throw new Error(`Wait open rejected: ${commit.transitionResult.code}`);
      return state;
    },
    async correlate(input: ResolveWaitCorrelationInput): Promise<WaitCorrelationResolution> {
      const currentTime = now();
      const projectedCandidates = await projections.waitCandidates(
        input.endpointId,
        input.channelId,
      );
      const candidates = projectedCandidates
        .filter(
          (record) =>
            record.status === "open" &&
            currentTime <= record.opened.deadline &&
            record.opened.endpointId === input.endpointId &&
            record.opened.channelId === input.channelId &&
            canonicalJson(record.opened.correlation) === canonicalJson(input.correlation),
        )
        .map((wait): WaitCorrelationCandidate => ({ key: `wait:${wait.waitId}`, wait }));
      if (candidates.length === 0) return { kind: "none", candidates: [] };
      if (candidates.length === 1) {
        return {
          kind: "match",
          candidate: requireValue(candidates[0], "matched Wait candidate is missing"),
        };
      }
      return { kind: "ambiguous", candidates };
    },
    async revalidatePinned(
      input: PinnedWaitRevalidationInputV1,
    ): Promise<PinnedWaitRevalidationV1> {
      const current = await projections.wait(input.pinned.waitId);
      if (current === undefined) return { kind: "invalid", reason: "wait does not exist" };
      if (!current.opened.allowedActions.includes(input.requestedAction))
        return { kind: "invalid", reason: "wait action is not allowed" };
      if (current.status === "open")
        return now() <= current.opened.deadline
          ? { kind: "valid", wait: current }
          : { kind: "invalid", reason: "wait deadline has elapsed" };
      if (current.status !== "resolved") return { kind: "invalid", reason: "wait is not routable" };
      if (current.routedAction !== input.requestedAction)
        return { kind: "invalid", reason: "wait resolved for a different action" };
      if (current.routingDeadlineDbMs === undefined || now() > current.routingDeadlineDbMs)
        return { kind: "invalid", reason: "wait routing deadline has elapsed" };
      if (
        input.resolvedSinceDbMs !== undefined &&
        current.resolvedAtDbMs !== undefined &&
        current.resolvedAtDbMs > input.resolvedSinceDbMs
      )
        return { kind: "invalid", reason: "wait resolution changed during dispatch" };
      return { kind: "valid", wait: current };
    },
    acceptResponse,
    async settle(input: WaitResponseInputV1) {
      const state = await acceptResponse(input);
      if (state.status !== "resolved") throw new Error("Wait threshold was not reached");
      return state;
    },
    async cancel(input: { readonly waitId: string; readonly reason: string }) {
      const { waitId, reason } = input;
      if (!waitId || !reason) throw new TypeError("wait cancellation requires waitId and reason");
      const current = requireValue(await projections.wait(waitId), `Wait not found: ${waitId}`);
      const event = Wait.CancelledV1.parse({
        version: "wait.cancelled.v1",
        waitId,
        ownerRef: current.opened.ownerRef,
        cancelledAtDbMs: now(),
        reason,
      });
      const committed = await transitions.commit({
        transitionId: "WT-08",
        requestId: `wait:cancel:${waitId}`,
        wait: { ...current, status: "cancelled" },
        event,
      });
      requireCommitted(committed, "Wait cancellation");
    },
    async stageAmbiguity(input: {
      readonly candidates: readonly WaitCorrelationCandidate[];
      readonly transportId: string;
    }) {
      const { candidates, transportId } = input;
      const firstCandidate = requireValue(candidates[0], "ambiguity requires candidate Waits");
      const first = requireValue(
        await projections.wait(firstCandidate.wait.waitId),
        `Wait not found: ${firstCandidate.wait.waitId}`,
      );
      const candidateWaitIds = [
        ...new Set(candidates.map((candidate) => candidate.wait.waitId)),
      ].sort();
      if (first.status !== "open" || candidateWaitIds.length < 2) {
        throw new TypeError("ambiguity requires distinct open Waits");
      }
      const event = Wait.AmbiguityRecordedV1.parse({
        version: "wait.ambiguity_recorded.v1",
        waitId: first.waitId,
        ownerRef: first.opened.ownerRef,
        candidateWaitIds,
        transportId,
        responseHash: sha256(transportId),
        recordedAtDbMs: now(),
      });
      const wait = first;
      const committed = await transitions.commit({
        transitionId: "WT-05",
        requestId: `wait:ambiguity:${transportId}`,
        wait: { ...wait, ambiguities: [...wait.ambiguities, event] },
        event,
      });
      requireCommitted(committed, "Wait ambiguity recording");
    },
    async markRouted(input: {
      readonly waitId: string;
      readonly dispatchId: string;
      readonly action: Wait.AllowedActionV1;
    }) {
      const { waitId, dispatchId, action } = input;
      const current = requireValue(await projections.wait(waitId), `Wait not found: ${waitId}`);
      if (
        current.status !== "resolved" ||
        current.routedDispatchId !== dispatchId ||
        current.routedAction !== action
      ) {
        throw new Error("Wait routed dispatch binding does not match the threshold receipt");
      }
    },
  });
}

function createMessagingWaitLifecycle(
  projections: WorkWaitProjectionPortV1,
  transitions: WorkWaitTransitionPortV1,
  waitKernel: WaitKernelService,
  now: () => number,
  config: WorkWaitProductionConfigV1,
): MessagingWaitLifecycle {
  const correlationFor = (input: ResidentAskInputV1) => ({
    endpointId: "resident",
    channelId: `worker:${input.sourceSessionId}:${input.sourceRunId}`,
    tokenHash: sha256(input.requestId),
  });
  const exactReceipt = (state: WaitRecordV1, input: ResidentAskInputV1): ResidentAskReceiptV1 => {
    const correlation = correlationFor(input);
    const attempt = state.opened.attempt;
    if (
      state.waitId !== input.requestId ||
      state.workItemId !== input.workItemId ||
      state.attemptId !== input.attemptId ||
      state.sessionId !== input.sourceSessionId ||
      state.sourceRunId !== input.sourceRunId ||
      state.targetSessionId !== input.targetSessionId ||
      state.payloadDigest !== sha256(input.payload) ||
      state.route.kind !== "worker" ||
      state.route.sessionId !== input.sourceSessionId ||
      state.route.runId !== input.sourceRunId ||
      attempt?.workItemId !== input.workItemId ||
      attempt?.attemptId !== input.attemptId ||
      attempt?.attemptSeq !== input.attemptSeq ||
      state.opened.endpointId !== correlation.endpointId ||
      state.opened.channelId !== correlation.channelId ||
      state.opened.correlation.tokenHash !== correlation.tokenHash
    )
      throw new Error("resident.ask callId is bound to a different Worker Attempt or request");
    return { waitId: state.waitId, correlation };
  };

  return Object.freeze({
    queries: Object.freeze({
      async attemptByExecution(input: Readonly<{ sessionId: string; runId: string }>) {
        const { sessionId, runId } = input;
        const attempt = await projections.attemptByRunId(runId);
        if (attempt === undefined) return undefined;
        return attempt.sessionId === sessionId &&
          (attempt.status === "running" || attempt.status === "waiting")
          ? attempt
          : undefined;
      },
    }),
    commands: Object.freeze({
      async openResidentAsk(input: ResidentAskInputV1) {
        if (
          !input.requestId ||
          !input.sourceSessionId ||
          !input.sourceRunId ||
          !input.targetSessionId
        )
          throw new TypeError("resident.ask requires stable call, source, and target bindings");
        const authoritative = await requireAttempt(projections, {
          workItemId: input.workItemId,
          attemptId: input.attemptId,
          attemptSeq: input.attemptSeq,
          sessionId: input.sourceSessionId,
          runId: input.sourceRunId,
          status: "running",
        });
        const existing = await projections.wait(input.requestId);
        if (existing !== undefined) return exactReceipt(existing, input);
        if (authoritative.status !== "running")
          throw new Error("resident.ask requires a running authoritative Worker Attempt");
        const correlation = correlationFor(input);
        const opened = Wait.OpenedV1.parse({
          version: "wait.opened.v1",
          waitId: input.requestId,
          ownerRef: { version: "wait-owner-ref-v1", kind: "workItem", id: input.workItemId },
          expectedResponders: [{ version: "wait-responder-ref-v1", actorId: "resident" }],
          endpointId: correlation.endpointId,
          channelId: correlation.channelId,
          correlation: { version: "wait-correlation-v1", tokenHash: correlation.tokenHash },
          allowedActions: ["report_result"],
          resolutionPolicy: "first-response",
          quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
          status: "open",
          deadline: now() + 300_000,
          partial: false,
          followUpWindow: 0,
          attempt: attemptRef(authoritative),
        });
        const wait: WaitRecordV1 = {
          waitId: input.requestId,
          revision: "1",
          opened,
          status: "open",
          route: { kind: "worker", sessionId: input.sourceSessionId, runId: input.sourceRunId },
          workItemId: input.workItemId,
          attemptId: input.attemptId,
          sessionId: input.sourceSessionId,
          sourceRunId: input.sourceRunId,
          targetSessionId: input.targetSessionId,
          payloadDigest: sha256(input.payload),
          responses: [],
          ambiguities: [],
        };
        const committed = await transitions.commit({
          transitionId: "DP-15",
          requestId: `resident-ask:${input.requestId}`,
          wait,
          attempt: { ...authoritative, status: "waiting" },
          dispatchId: `resident-ask:${input.requestId}`,
        });
        requireCommitted(committed, "resident.ask open");
        const durable = requireValue(
          await projections.wait(input.requestId),
          "resident.ask committed without a durable Wait projection",
        );
        return exactReceipt(durable, input);
      },
      async resumeAfterResolvedWait(waitId: string) {
        const wait = requireValue(
          await projections.wait(waitId),
          "resident.ask resume requires the durably resolved Wait",
        );
        if (
          wait.status !== "resolved" ||
          wait.opened.attempt === undefined ||
          wait.resolved === undefined
        )
          throw new Error("resident.ask resume requires the durably resolved Wait");
        const attempt = await requireAttemptRef(projections, wait.opened.attempt);
        if (
          wait.route.kind !== "worker" ||
          wait.route.sessionId !== attempt.sessionId ||
          wait.route.runId !== attempt.runId
        )
          throw new Error("resident.ask resolved Wait is not bound to the same Worker Attempt");
        const sourceRef = `wait:resume:${waitId}`;
        const effect = workerEffect(attempt, sourceRef, "coordinator.message.v1");
        const effectScope = config.workerEffectScope(sourceRef, "coordinator.message.v1");
        const existing = await projections.effect(effect.effectId);
        if (existing !== undefined) {
          requireExactReplayEffect(existing, effect, "resident.ask resume");
          return deliveryReplayDisposition(existing, effectScope);
        }
        if (attempt.status !== "waiting") {
          throw new Error("resident.ask resume requires the same waiting Worker Attempt");
        }
        const resume = Wait.ResumeRequestedV1.parse({
          version: "wait.resume_requested.v1",
          waitId,
          ownerRef: wait.opened.ownerRef,
          attempt: attemptRef(attempt),
          responseEventIds: wait.resolved.responseEventIds,
          requestedAtDbMs: now(),
        });
        const committed = await transitions.commit({
          transitionId: "AT-12",
          requestId: sourceRef,
          attempt,
          effect,
          effectScope,
          waitResume: resume,
        });
        requireCommitted(committed, "resident.ask resume intent");
        const binding = requireValue(
          committed.effectBinding,
          "resident.ask resume committed without an exact effect binding",
        );
        requireExactEffectBinding(binding, effect, effectScope, "resident.ask resume");
        return Object.freeze({ disposition: "act", delivery: binding });
      },
      cancel: (waitId: string, reason: string) => waitKernel.cancel({ waitId, reason }),
    }),
  });
}

async function requireAttempt(
  projections: WorkWaitProjectionPortV1,
  claimed: WorkerAttemptProjection,
): Promise<WorkAttemptRecordV1> {
  const current = requireValue(
    await projections.attempt(claimed.attemptId),
    "Attempt transition denied: Attempt not found",
  );
  if (
    current.workItemId !== claimed.workItemId ||
    current.attemptSeq !== claimed.attemptSeq ||
    current.runId !== claimed.runId ||
    current.sessionId !== claimed.sessionId
  ) {
    throw new Error("Attempt transition denied: immutable Attempt binding mismatch");
  }
  return current;
}

async function requireAttemptRef(projections: WorkWaitProjectionPortV1, ref: Ledger.AttemptRefV1) {
  const current = requireValue(await projections.attempt(ref.attemptId), "Attempt not found");
  if (current.workItemId !== ref.workItemId || current.attemptSeq !== ref.attemptSeq)
    throw new Error("immutable Attempt binding mismatch");
  return current;
}

function attemptRef(attempt: WorkerAttemptProjection): Ledger.AttemptRefV1 {
  return Ledger.AttemptRefV1.parse({
    version: "attempt-ref-v1",
    workItemId: attempt.workItemId,
    attemptId: attempt.attemptId,
    attemptSeq: attempt.attemptSeq,
  });
}

function terminalTransition(
  status: WorkerAttemptTerminalStatus,
): "AT-08" | "AT-09" | "AT-10" | "AT-11" {
  if (status === "succeeded") return "AT-08";
  if (status === "cancelled") return "AT-10";
  if (status === "interrupted") return "AT-11";
  return "AT-09";
}

function effectForAttemptTransition(
  current: WorkAttemptRecordV1,
  transitionId: string,
): EffectRecordV1 | undefined {
  if (!["AT-02", "AT-03", "AT-04"].includes(transitionId)) return undefined;
  const start = transitionId === "AT-02";
  return {
    effectId: start
      ? `credential-provisioning:${current.attemptId}`
      : `coordinator-spawn:${current.runId}`,
    sourceRef: start
      ? `credential-provisioning:${current.attemptId}`
      : `worker-allocation:${current.runId}`,
    workItemId: current.workItemId,
    attemptId: current.attemptId,
    attempt: attemptRef(current),
    settlement:
      transitionId === "AT-03"
        ? "confirmed"
        : transitionId === "AT-04"
          ? "definite_failed"
          : "pending",
    operation: start ? "worker.credential_provision.v1" : "coordinator.spawn.v1",
  };
}

function sameResponder(left: Wait.ResponderRefV1, right: Wait.ResponderRefV1): boolean {
  return left.actorId === right.actorId && left.endpointId === right.endpointId;
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function parseCompletionVerdict(value: unknown): CompletionClaimVerdictV1 {
  const record = semanticRecord(value);
  const version = semanticString(record, "version");
  const candidateRef = semanticString(record, "candidateRef");
  const candidate = WorkItem.CompletionReport.parse(record.candidate);
  const claimIndex = record.claimIndex;
  const claimDigest = semanticString(record, "claimDigest");
  const evidenceIds = semanticStringArray(record, "evidenceIds");
  const status = semanticString(record, "status");
  if (
    version !== "completion-claim-verdict-v1" ||
    !Number.isInteger(claimIndex) ||
    (claimIndex as number) < 0 ||
    (status !== "passed" && status !== "failed" && status !== "pending") ||
    Object.keys(record).some(
      (key) =>
        ![
          "version",
          "candidateRef",
          "candidate",
          "claimIndex",
          "claimDigest",
          "evidenceIds",
          "status",
        ].includes(key),
    )
  ) {
    throw new TypeError("completion verdict is malformed");
  }
  return Object.freeze({
    version,
    candidateRef,
    candidate,
    claimIndex: claimIndex as number,
    claimDigest,
    evidenceIds: Object.freeze([...evidenceIds]),
    status,
  });
}

function parseCompletionAdmissionDecision(value: unknown): CompletionAdmissionDecisionV1 {
  const record = semanticRecord(value);
  const admission = semanticRecord(record.admission);
  const verdictValues = record.verdicts;
  if (
    record.version !== "completion-admission-decision-v1" ||
    !Array.isArray(verdictValues) ||
    !Number.isInteger(record.stakesAsOfLedgerSeq) ||
    !Number.isFinite(record.stakesAsOfDbMs) ||
    Object.keys(record).some(
      (key) =>
        ![
          "version",
          "candidate",
          "candidateRef",
          "verdicts",
          "verdictRefs",
          "stakesAsOfLedgerSeq",
          "stakesAsOfDbMs",
          "admission",
        ].includes(key),
    ) ||
    Object.keys(admission).length !== 6 ||
    ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6"].some(
      (criterion) => admission[criterion] !== true,
    )
  ) {
    throw new TypeError("completion admission decision is malformed");
  }
  return Object.freeze({
    version: "completion-admission-decision-v1",
    candidate: WorkItem.CompletionReport.parse(record.candidate),
    candidateRef: semanticString(record, "candidateRef"),
    verdicts: Object.freeze(verdictValues.map(parseCompletionVerdict)),
    verdictRefs: Object.freeze([...semanticStringArray(record, "verdictRefs")]),
    stakesAsOfLedgerSeq: record.stakesAsOfLedgerSeq as number,
    stakesAsOfDbMs: record.stakesAsOfDbMs as number,
    admission: Object.freeze({
      "AC-1": true,
      "AC-2": true,
      "AC-3": true,
      "AC-4": true,
      "AC-5": true,
      "AC-6": true,
    }),
  });
}

function completionVerdictBindsClaim(verdict: CompletionClaimVerdictV1): boolean {
  const claim = verdict.candidate.claims[verdict.claimIndex];
  return (
    claim !== undefined &&
    verdict.claimDigest === sha256(canonicalJson(claim)) &&
    sameValue(verdict.evidenceIds, claim.evidenceIds)
  );
}

function completionAdmissionIsExact(
  work: WorkRecordV1,
  completion: CompletionRecordV1,
  decision: CompletionAdmissionDecisionV1,
): boolean {
  if (
    decision.candidateRef !== completion.candidateRef ||
    sha256(canonicalJson(decision.candidate)) !== completion.candidateRef ||
    decision.stakesAsOfLedgerSeq !== completion.stakesAsOfLedgerSeq ||
    decision.stakesAsOfDbMs !== completion.stakesAsOfDbMs ||
    (work.activeBlockerRefs ?? []).length !== 0 ||
    decision.verdicts.length !== decision.candidate.claims.length ||
    decision.verdictRefs.length !== decision.verdicts.length ||
    completion.verdictRefs.length !== decision.verdicts.length
  ) {
    return false;
  }
  const persistedRefs = new Set(completion.verdictRefs);
  const suppliedRefs = new Set(decision.verdictRefs);
  if (
    persistedRefs.size !== completion.verdictRefs.length ||
    suppliedRefs.size !== decision.verdictRefs.length
  )
    return false;
  const covered = new Set<number>();
  for (const [position, verdict] of decision.verdicts.entries()) {
    const claim = decision.candidate.claims[verdict.claimIndex];
    const verdictRef = sha256(canonicalJson(verdict));
    if (
      claim === undefined ||
      verdict.status !== "passed" ||
      verdict.candidateRef !== completion.candidateRef ||
      sha256(canonicalJson(verdict.candidate)) !== completion.candidateRef ||
      !completionVerdictBindsClaim(verdict) ||
      verdict.claimDigest !== sha256(canonicalJson(claim)) ||
      !sameValue(verdict.evidenceIds, claim.evidenceIds) ||
      covered.has(verdict.claimIndex) ||
      decision.verdictRefs[position] !== verdictRef ||
      !persistedRefs.has(verdictRef)
    ) {
      return false;
    }
    covered.add(verdict.claimIndex);
  }
  return covered.size === decision.candidate.claims.length;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
