import { createHash, randomBytes } from "node:crypto";
import {
  Execution,
  AppConnector,
  type Dispatch,
  type Ipc,
  type Ledger,
  type Model,
} from "@openomni/protocol";
import {
  bindAuthenticatedWorkerKernelPort,
  type AuthenticatedWorkerTargetBindingV1,
  type KernelProjectionPortV1,
  type KernelQueryPortV1,
  type KernelTransitionPortV1,
  WorkerIdentityMismatchError,
  WorkerTransitionForbiddenError,
} from "../ports.js";
import type {
  WorkerLedgerBinding,
  WorkerLedgerSemanticRequestV1,
  WorkerLedgerService,
} from "../../dispatch/handlers/worker-work-item.js";

export interface WorkerKernelChannelIdentityV1 {
  readonly runtimeId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly principalId: string;
  readonly processId: number;
  readonly attempt: Ledger.AttemptRefV1;
}

export interface WorkerKernelTransitionFrameV1 {
  readonly channelIdentity: WorkerKernelChannelIdentityV1;
  readonly request: Omit<Ipc.WorkerKernelTransitionRequestV1, "authToken">;
}

export interface WorkerKernelQueryFrameV1 {
  readonly channelIdentity: WorkerKernelChannelIdentityV1;
  readonly request: Omit<Ipc.WorkerKernelQueryRequestV1, "authToken">;
}

export interface ActiveWorkerBindingV1 {
  readonly runtimeId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly principalId: string;
  readonly processId: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly attempt: Ledger.AttemptRefV1;
}

export interface WorkerAttemptRowV1 {
  readonly owner: Ledger.OwnerV1;
  readonly sessionId: string;
  readonly runId: string;
  readonly status:
    | "starting"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  readonly attempt: Ledger.AttemptRefV1;
  readonly binding?: ActiveWorkerBindingV1;
}

export interface WorkerEffectBindingV1 {
  readonly effect: Ledger.EffectRefV1;
  readonly effectScope: Execution.EffectScopeV1;
}

export interface ProductionWorkerSemanticDependencies {
  readonly queries: {
    attemptByRunId(runId: string): Promise<WorkerAttemptRowV1 | undefined>;
    workSession(workItemId: string): Promise<string | undefined>;
    waitIdsByAttempt(attemptId: string): Promise<readonly string[]>;
    effectsByAttempt(attemptId: string): Promise<readonly WorkerEffectBindingV1[]>;
    head(owner: Ledger.OwnerV1): Promise<Ledger.HeadV1>;
  };
  readonly projections: KernelProjectionPortV1;
  readonly workerLedger: WorkerLedgerService;
}

export interface ProductionWorkerSemanticPorts {
  readonly transition: (
    frame: WorkerKernelTransitionFrameV1,
  ) => Promise<Ipc.WorkerKernelTransitionResultV1>;
  readonly query: (frame: WorkerKernelQueryFrameV1) => Promise<Ipc.WorkerKernelQueryResultV1>;
}

interface ResolvedWorkerBindingV1 {
  readonly identity: Execution.AuthenticatedWorkerIdentityV1;
  readonly target: AuthenticatedWorkerTargetBindingV1;
}

function sameAttempt(left: Ledger.AttemptRefV1, right: Ledger.AttemptRefV1): boolean {
  return (
    left.version === right.version &&
    left.workItemId === right.workItemId &&
    left.attemptId === right.attemptId &&
    left.attemptSeq === right.attemptSeq
  );
}

function sameWorkerLedgerTarget(
  binding: ResolvedWorkerBindingV1,
  target: WorkerLedgerBinding,
): boolean {
  return (
    target.owner.ownerKey === binding.target.owner.ownerKey &&
    target.workItemId === binding.target.attempt.workItemId &&
    target.runId === binding.identity.runId &&
    sameAttempt(target.attempt, binding.target.attempt)
  );
}

function canonicalSemanticValue(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalSemanticValue).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalSemanticValue(nested)}`)
    .join(",")}}`;
}

function semanticRequestHash(request: WorkerLedgerSemanticRequestV1): string {
  return createHash("sha256")
    .update(
      canonicalSemanticValue({
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
    )
    .digest("hex");
}

function serverDerivedWorkerContent(
  binding: ResolvedWorkerBindingV1,
  transitionId: Execution.NativeTransitionIdV1,
  requestId: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: "authenticated-worker-transition-v1",
    transitionId,
    requestId,
    identity: binding.identity,
    target: Object.freeze({
      owner: binding.target.owner,
      workItemId: binding.target.attempt.workItemId,
      runId: binding.identity.runId,
      attempt: binding.target.attempt,
    }),
  });
}

async function commitAuthenticatedWorkerTransition(
  deps: ProductionWorkerSemanticDependencies,
  binding: ResolvedWorkerBindingV1,
  command: Execution.KernelTransitionCommandV1,
): Promise<Execution.KernelTransitionResultV1> {
  const transitionId = Execution.NativeTransitionIdV1.parse(command.transitionId);
  const target = await deps.workerLedger.resolveAttemptByRunId(binding.identity.runId);
  if (target === undefined || !sameWorkerLedgerTarget(binding, target)) {
    throw new WorkerIdentityMismatchError("attemptId");
  }
  const content = serverDerivedWorkerContent(binding, transitionId, command.requestId);
  const evidenceRef = createHash("sha256").update(canonicalSemanticValue(content)).digest("hex");
  const unhashed: WorkerLedgerSemanticRequestV1 = {
    transitionId,
    requestId: command.requestId,
    requestHash: "",
    target,
    content,
    ...(command.transitionId === "WI-06" ||
    command.transitionId === "WI-07" ||
    command.transitionId === "WI-08"
      ? { evidenceRef }
      : {}),
  };
  const result = await deps.workerLedger.commitSemanticTransition({
    ...unhashed,
    requestHash: semanticRequestHash(unhashed),
  });
  return result.transitionResult;
}

function exactWorkerBinding(
  channel: WorkerKernelChannelIdentityV1,
  request: {
    readonly workerId: string;
    readonly generation: number;
    readonly sessionId: string;
    readonly runId: string;
  },
  row: WorkerAttemptRowV1,
): boolean {
  const binding = row.binding;
  if (binding === undefined) return false;
  return (
    request.workerId === channel.workerId &&
    request.generation === channel.generation &&
    request.sessionId === row.sessionId &&
    request.runId === row.runId &&
    channel.runtimeId === binding.runtimeId &&
    channel.workerId === binding.workerId &&
    channel.generation === binding.generation &&
    channel.principalId === binding.principalId &&
    channel.processId === binding.processId &&
    request.sessionId === binding.sessionId &&
    request.runId === binding.runId &&
    sameAttempt(channel.attempt, row.attempt) &&
    sameAttempt(channel.attempt, binding.attempt)
  );
}

async function resolveWorkerBinding(
  deps: ProductionWorkerSemanticDependencies,
  channel: WorkerKernelChannelIdentityV1,
  request: {
    readonly workerId: string;
    readonly generation: number;
    readonly sessionId: string;
    readonly runId: string;
  },
): Promise<ResolvedWorkerBindingV1> {
  const row = await deps.queries.attemptByRunId(request.runId);
  if (
    row === undefined ||
    !exactWorkerBinding(channel, request, row) ||
    (row.status !== "starting" && row.status !== "running" && row.status !== "waiting")
  ) {
    throw new WorkerIdentityMismatchError("attemptId");
  }
  const workSession = await deps.queries.workSession(row.attempt.workItemId);
  if (workSession !== row.sessionId) throw new WorkerIdentityMismatchError("sessionId");
  const [waitIds, effects] = await Promise.all([
    deps.queries.waitIdsByAttempt(row.attempt.attemptId),
    deps.queries.effectsByAttempt(row.attempt.attemptId),
  ]);
  const identity: Execution.AuthenticatedWorkerIdentityV1 = Object.freeze({
    version: "authenticated-worker-identity-v1",
    runtimeId: channel.runtimeId,
    workerId: channel.workerId,
    generation: channel.generation,
    principalId: channel.principalId,
    sessionId: row.sessionId,
    runId: row.runId,
    attemptId: row.attempt.attemptId,
  });
  const target: AuthenticatedWorkerTargetBindingV1 = Object.freeze({
    owner: Object.freeze({ ...row.owner }),
    attempt: Object.freeze({ ...row.attempt }),
    waitIds: Object.freeze([...waitIds]),
    effects: Object.freeze(
      effects.map(({ effect, effectScope }) =>
        Object.freeze({
          effect: Object.freeze({ ...effect }),
          effectScope: structuredClone(effectScope),
        }),
      ),
    ),
  });
  return Object.freeze({ identity, target });
}

function rejectedWorkerTransition(
  error: WorkerTransitionForbiddenError | WorkerIdentityMismatchError,
): Ipc.WorkerKernelTransitionResultV1 {
  return {
    version: "kernel-transition-result-v1",
    status: "rejected",
    code:
      error instanceof WorkerTransitionForbiddenError
        ? "transition_forbidden"
        : "identity_mismatch",
  };
}

export function createWorkerSemanticPorts(
  deps: ProductionWorkerSemanticDependencies,
): ProductionWorkerSemanticPorts {
  const unavailableQueries: KernelQueryPortV1 = Object.freeze({
    query: async () => {
      throw new Error("query unavailable on Worker transition port");
    },
  });
  const unavailableTransitions: KernelTransitionPortV1 = Object.freeze({
    execute: async () => {
      throw new Error("transition unavailable on Worker query port");
    },
  });
  return Object.freeze({
    async transition(frame: WorkerKernelTransitionFrameV1) {
      try {
        const binding = await resolveWorkerBinding(deps, frame.channelIdentity, frame.request);
        const expectedHead = await deps.queries.head(binding.target.owner);
        const parsed = Execution.KernelTransitionCommandV1.safeParse({
          ...frame.request.command,
          identity: binding.identity,
          expectedHead,
        });
        if (!parsed.success)
          throw new WorkerTransitionForbiddenError(frame.request.command.transitionId);
        const semanticTransitions: KernelTransitionPortV1 = Object.freeze({
          execute: (command: Execution.KernelTransitionCommandV1) =>
            commitAuthenticatedWorkerTransition(deps, binding, command),
        });
        const bound = bindAuthenticatedWorkerKernelPort(
          binding.identity,
          binding.target,
          semanticTransitions,
          unavailableQueries,
        );
        const { identity: _identity, ...command } = parsed.data;
        return await bound.execute(command);
      } catch (error) {
        if (
          error instanceof WorkerTransitionForbiddenError ||
          error instanceof WorkerIdentityMismatchError
        ) {
          return rejectedWorkerTransition(error);
        }
        throw error;
      }
    },
    async query(frame: WorkerKernelQueryFrameV1) {
      const binding = await resolveWorkerBinding(deps, frame.channelIdentity, frame.request);
      const parsed = Execution.KernelQueryV1.safeParse({
        ...frame.request.request,
        identity: binding.identity,
      });
      if (!parsed.success) throw new WorkerIdentityMismatchError("attemptId");
      const bound = bindAuthenticatedWorkerKernelPort(
        binding.identity,
        binding.target,
        unavailableTransitions,
        deps.projections,
      );
      const { identity: _identity, ...request } = parsed.data;
      return bound.query(request);
    },
  });
}

export interface ConnectorEndpointWorkerSpawnPayloadV1 {
  readonly prompt: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints?: readonly string[];
}

export interface ConnectorAttemptProjectionV1 {
  readonly workItemId: string;
  readonly attemptId: string;
  readonly attempt: Ledger.AttemptRefV1;
  readonly request: Execution.Request;
  readonly settlementClaimId: string;
}

export type ConnectorAttemptBeginResultV1 =
  | Readonly<{ disposition: "new"; attempt: ConnectorAttemptProjectionV1 }>
  | Readonly<{
      disposition: "in_progress_or_unknown";
      attempt: ConnectorAttemptProjectionV1;
    }>
  | Readonly<{
      disposition: "terminal_replay";
      attempt: ConnectorAttemptProjectionV1;
      settlement: ConnectorAttemptSettlementResultV1;
    }>;

export type ConnectorAttemptSettlementResultV1 =
  | Readonly<{ status: "succeeded"; result: Execution.Result }>
  | Readonly<{ status: "failed"; error: string }>;

export interface ConnectorArtifactInputV1 {
  readonly ownerSessionId: string;
  readonly artifactId: string;
  readonly mediaType: string;
  readonly title: string;
  readonly content: Uint8Array;
}

export interface ConnectorContentBlobV1 {
  readonly bytes: Uint8Array;
  readonly ref: {
    readonly version: "content-blob-ref-v1";
    readonly digest: string;
    readonly byteLength: number;
    readonly mediaType: string;
  };
}

export interface ConnectorAttemptReceiptRowV1 {
  readonly workItemId: string;
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly model: Model.Ref;
  readonly connectorInstallationId: string;
  readonly settlement?: ConnectorAttemptSettlementResultV1;
}

export interface ConnectorStartEffectProofV1 {
  readonly effectId: string;
  readonly sourceRef: string;
  readonly operation: "connector.submit.v1";
  readonly attempt: Ledger.AttemptRefV1;
  readonly scope: Execution.EffectScopeV1;
}

export interface ProductionConnectorDependencies {
  readonly workspaceRoot: string;
  readonly modelEnvironment: Execution.LLMEnvironmentV1;
  readonly queries: {
    connectorInstallation(id: string): Promise<AppConnector.Installation | undefined>;
    attemptByRunId(runId: string): Promise<ConnectorAttemptReceiptRowV1 | undefined>;
  };
  readonly lifecycle: {
    createWork(
      input: Readonly<{
        transitionId: "WI-01";
        ownerKey: string;
        workItemId: string;
        sessionId: string;
        name: string;
        requestId: string;
      }>,
    ): Promise<void>;
    readyWork(
      input: Readonly<{
        transitionId: "WI-02";
        ownerKey: string;
        workItemId: string;
        requestId: string;
      }>,
    ): Promise<void>;
    allocateAttempt(
      input: Readonly<{
        transitionId: "AT-01";
        ownerKey: string;
        attempt: Ledger.AttemptRefV1;
        sessionId: string;
        runId: string;
        request: Execution.Request;
        installation: AppConnector.Installation;
        environment: Execution.LLMEnvironmentV1;
        executionClaimId: string;
        requestId: string;
      }>,
    ): Promise<void>;
    requestAttemptStart(
      input: Readonly<{
        transitionId: "AT-02";
        ownerKey: string;
        attempt: Ledger.AttemptRefV1;
        request: Execution.Request;
        installation: AppConnector.Installation;
        effect: ConnectorStartEffectProofV1;
        requestId: string;
      }>,
    ): Promise<ConnectorStartEffectProofV1>;
    confirmAttemptStart(
      input: Readonly<{
        transitionId: "AT-03";
        ownerKey: string;
        attempt: Ledger.AttemptRefV1;
        effect: ConnectorStartEffectProofV1;
        requestId: string;
      }>,
    ): Promise<void>;
    settleAttempt(
      input: Readonly<{
        transitionId: "AT-07" | "AT-08";
        attempt: Ledger.AttemptRefV1;
        error?: string;
        settlement: ConnectorAttemptSettlementResultV1;
        requestId: string;
      }>,
    ): Promise<void>;
  };
  readonly artifacts: {
    putAndReference(
      input: Readonly<{
        transitionId: "AF-01";
        ownerSessionId: string;
        artifactId: string;
        title: string;
        blob: ConnectorContentBlobV1;
        requestId: string;
      }>,
    ): Promise<void>;
  };
}

export interface ProductionConnectorServices {
  readonly queries: {
    resolveInstallation(target: Dispatch.Target): Promise<AppConnector.Installation | undefined>;
  };
  readonly transitions: {
    beginAttempt(
      input: Readonly<{
        command: Dispatch.Command;
        model: Model.Ref;
        payload: ConnectorEndpointWorkerSpawnPayloadV1;
        installation: AppConnector.Installation;
      }>,
    ): Promise<ConnectorAttemptBeginResultV1>;
    settleAttempt(
      input: Readonly<{
        attempt: ConnectorAttemptProjectionV1;
        settlement: ConnectorAttemptSettlementResultV1;
      }>,
    ): Promise<Readonly<{ reflection?: unknown }>>;
  };
  readonly artifacts: {
    putAndReference(input: ConnectorArtifactInputV1): Promise<void>;
  };
}

function nonEmpty(value: string, field: string): string {
  if (value.length === 0) throw new TypeError(`${field} must be non-empty`);
  return value;
}

function exactConnectorTarget(
  target: Dispatch.Target,
  installation: AppConnector.Installation,
): boolean {
  return (
    target.kind === "worker" &&
    target.connectorInstallationId === installation.id &&
    target.endpointId === installation.endpointId
  );
}

function connectorStartEffectProof(
  attempt: Ledger.AttemptRefV1,
  request: Execution.Request,
  installation: AppConnector.Installation,
  workspaceRoot: string,
): ConnectorStartEffectProofV1 {
  const workspaceDigest = createHash("sha256").update(workspaceRoot).digest("hex");
  const inputDigest = createHash("sha256")
    .update(
      canonicalSemanticValue({
        action: "worker.spawn",
        endpointId: installation.endpointId,
        installationId: installation.id,
        connectorVersion: installation.connectorVersion,
        runId: request.runId,
        sessionId: request.sessionId,
        prompt: request.prompt,
      }),
    )
    .digest("hex");
  const sourceRef = createHash("sha256")
    .update(
      canonicalSemanticValue({
        version: "connector-start-source-v1",
        attempt,
        installationId: installation.id,
        endpointId: installation.endpointId,
        inputDigest,
      }),
    )
    .digest("hex");
  return Object.freeze({
    effectId: `connector-effect:${sourceRef}`,
    sourceRef,
    operation: "connector.submit.v1",
    attempt: Object.freeze({ ...attempt }),
    scope: Execution.EffectScopeV1.parse({
      version: "effect-scope-v1",
      workspace: {
        canonicalizerVersion: "workspace-v1",
        workspaceId: `w1:${workspaceDigest}`,
        canonicalBytesDigest: workspaceDigest,
      },
      resources: [
        {
          version: "resource-scope-v1",
          kind: "connector",
          installationId: installation.id,
          definitionVersion: installation.connectorVersion,
        },
        {
          version: "resource-scope-v1",
          kind: "endpoint",
          targetDigest: createHash("sha256").update(installation.endpointId).digest("hex"),
        },
      ],
      resolver: { id: "connector-installation-v1", version: "1", inputDigest },
      containment: "connector-declared",
      mutationClass: "unknown",
    }),
  });
}

function connectorPrompt(payload: ConnectorEndpointWorkerSpawnPayloadV1): string {
  const acceptanceCriteria = payload.acceptanceCriteria.map((criterion) => `- ${criterion}`);
  const constraints = payload.constraints?.map((constraint) => `- ${constraint}`) ?? [];
  return [
    payload.prompt,
    "",
    "Acceptance criteria:",
    ...(acceptanceCriteria.length === 0 ? ["- None specified"] : acceptanceCriteria),
    ...(constraints.length === 0 ? [] : ["", "Constraints:", ...constraints]),
  ].join("\n");
}

interface ConnectorSettlementSnapshotV1 {
  readonly attempt: Ledger.AttemptRefV1;
  readonly attemptId: string;
  readonly runId: string;
  readonly sessionId: string;
}

function connectorSettlementClaimId(snapshot: ConnectorSettlementSnapshotV1): string {
  return createHash("sha256")
    .update(
      canonicalSemanticValue({
        version: "connector-settlement-claim-v1",
        attempt: snapshot.attempt,
        attemptId: snapshot.attemptId,
        runId: snapshot.runId,
        sessionId: snapshot.sessionId,
      }),
    )
    .digest("hex");
}

function exactConnectorAttemptReceipt(
  row: ConnectorAttemptReceiptRowV1,
  snapshot: ConnectorSettlementSnapshotV1,
  request: Execution.Request,
  installationId: string,
): boolean {
  return (
    row.workItemId === snapshot.attempt.workItemId &&
    row.attemptId === snapshot.attempt.attemptId &&
    row.attemptSeq === snapshot.attempt.attemptSeq &&
    row.sessionId === snapshot.sessionId &&
    row.runId === snapshot.runId &&
    row.prompt === request.prompt &&
    canonicalSemanticValue(row.model) === canonicalSemanticValue(request.model) &&
    row.connectorInstallationId === installationId
  );
}

export function createConnectorArtifactServices(
  deps: ProductionConnectorDependencies,
): ProductionConnectorServices {
  nonEmpty(deps.workspaceRoot, "workspaceRoot");
  return Object.freeze({
    queries: Object.freeze({
      async resolveInstallation(target: Dispatch.Target) {
        const id = target.connectorInstallationId;
        if (id === undefined || target.endpointId === undefined || target.kind !== "worker") {
          return undefined;
        }
        const installation = await deps.queries.connectorInstallation(id);
        if (installation === undefined) return undefined;
        const parsed = AppConnector.Installation.safeParse(installation);
        return parsed.success && exactConnectorTarget(target, parsed.data)
          ? Object.freeze(parsed.data)
          : undefined;
      },
    }),
    transitions: Object.freeze({
      async beginAttempt(
        input: Readonly<{
          command: Dispatch.Command;
          model: Model.Ref;
          payload: ConnectorEndpointWorkerSpawnPayloadV1;
          installation: AppConnector.Installation;
        }>,
      ): Promise<ConnectorAttemptBeginResultV1> {
        const commandSessionId = nonEmpty(input.command.sessionId ?? "", "connector sessionId");
        const actorSessionId = nonEmpty(
          input.command.actor.sessionId ?? "",
          "connector actor sessionId",
        );
        if (commandSessionId !== actorSessionId) {
          throw new Error("connector actor/session binding does not match");
        }
        if (
          input.command.actor.runId !== undefined &&
          input.command.runId !== undefined &&
          input.command.actor.runId !== input.command.runId
        ) {
          throw new Error("connector actor/run binding does not match");
        }
        const sessionId = commandSessionId;
        const runId = nonEmpty(input.command.dispatchId, "connector dispatchId");
        const installation = await deps.queries.connectorInstallation(
          input.command.target.connectorInstallationId ?? "",
        );
        const parsedInstallation = AppConnector.Installation.safeParse(installation);
        if (
          !parsedInstallation.success ||
          !exactConnectorTarget(input.command.target, parsedInstallation.data) ||
          canonicalSemanticValue(parsedInstallation.data) !==
            canonicalSemanticValue(input.installation) ||
          parsedInstallation.data.status !== "enabled" ||
          parsedInstallation.data.consent === undefined ||
          parsedInstallation.data.definition.profile.kind !== "connector_endpoint"
        ) {
          throw new Error("connector installation is not enabled, consented, and endpoint-scoped");
        }
        const authoritativeInstallation = Object.freeze(parsedInstallation.data);
        const workDigest = createHash("sha256").update(`${sessionId}\0${runId}`).digest("hex");
        const workItemId = `work-${workDigest.slice(0, 32)}`;
        const ownerKey = `work:${workItemId}`;
        const attempt: Ledger.AttemptRefV1 = Object.freeze({
          version: "attempt-ref-v1",
          workItemId,
          attemptId: runId,
          attemptSeq: 1,
        });
        const executionClaimId = randomBytes(32).toString("hex");
        const request = Execution.Request.parse({
          runId,
          sessionId,
          mode: "direct",
          prompt: connectorPrompt(input.payload),
          model: input.model,
          workspaceRoot: deps.workspaceRoot,
        });
        const snapshot: ConnectorSettlementSnapshotV1 = Object.freeze({
          attempt: Object.freeze({ ...attempt }),
          attemptId: runId,
          runId,
          sessionId,
        });
        const settlementClaimId = connectorSettlementClaimId(snapshot);
        const projection = Object.freeze({
          workItemId,
          attemptId: runId,
          attempt,
          request: Object.freeze(request),
          settlementClaimId,
        });
        const existing = await deps.queries.attemptByRunId(runId);
        if (
          existing !== undefined &&
          !exactConnectorAttemptReceipt(existing, snapshot, request, authoritativeInstallation.id)
        ) {
          throw new Error("connector attempt is already reserved");
        }
        if (
          existing?.status === "allocated" ||
          existing?.status === "starting" ||
          existing?.status === "running" ||
          existing?.status === "waiting"
        ) {
          return Object.freeze({ disposition: "in_progress_or_unknown", attempt: projection });
        }
        if (existing?.status === "succeeded" || existing?.status === "failed") {
          if (existing.settlement === undefined) {
            return Object.freeze({ disposition: "in_progress_or_unknown", attempt: projection });
          }
          if ((existing.status === "succeeded") !== (existing.settlement.status === "succeeded")) {
            throw new Error("connector terminal outcome is malformed");
          }
          return Object.freeze({
            disposition: "terminal_replay",
            attempt: projection,
            settlement: existing.settlement,
          });
        }
        if (existing !== undefined) {
          throw new Error("connector attempt is already reserved");
        }
        await deps.lifecycle.createWork({
          transitionId: "WI-01",
          ownerKey,
          workItemId,
          sessionId,
          name: `Connector ${authoritativeInstallation.id}`,
          requestId: `connector:work:${runId}`,
        });
        await deps.lifecycle.readyWork({
          transitionId: "WI-02",
          ownerKey,
          workItemId,
          requestId: `connector:ready:${runId}`,
        });
        try {
          await deps.lifecycle.allocateAttempt({
            transitionId: "AT-01",
            ownerKey,
            attempt,
            sessionId,
            runId,
            request,
            installation: authoritativeInstallation,
            environment: deps.modelEnvironment,
            executionClaimId,
            requestId: `connector:allocate:${runId}`,
          });
        } catch (error) {
          const raced = await deps.queries.attemptByRunId(runId);
          if (
            raced === undefined ||
            !exactConnectorAttemptReceipt(raced, snapshot, request, authoritativeInstallation.id)
          ) {
            throw error;
          }
          if (
            (raced.status === "succeeded" || raced.status === "failed") &&
            raced.settlement !== undefined
          ) {
            return Object.freeze({
              disposition: "terminal_replay",
              attempt: projection,
              settlement: raced.settlement,
            });
          }
          return Object.freeze({ disposition: "in_progress_or_unknown", attempt: projection });
        }
        const requestedStartEffect = connectorStartEffectProof(
          attempt,
          request,
          authoritativeInstallation,
          deps.workspaceRoot,
        );
        const startEffect = await deps.lifecycle.requestAttemptStart({
          transitionId: "AT-02",
          ownerKey,
          attempt,
          request,
          installation: authoritativeInstallation,
          effect: requestedStartEffect,
          requestId: `connector:start-intent:${runId}`,
        });
        if (canonicalSemanticValue(startEffect) !== canonicalSemanticValue(requestedStartEffect)) {
          throw new Error("connector start effect proof denied");
        }
        await deps.lifecycle.confirmAttemptStart({
          transitionId: "AT-03",
          ownerKey,
          attempt,
          effect: startEffect,
          requestId: `connector:start-confirm:${runId}`,
        });
        return Object.freeze({ disposition: "new", attempt: projection });
      },
      async settleAttempt(
        input: Readonly<{
          attempt: ConnectorAttemptProjectionV1;
          settlement: ConnectorAttemptSettlementResultV1;
        }>,
      ): Promise<Readonly<{ reflection?: unknown }>> {
        const snapshot: ConnectorSettlementSnapshotV1 = Object.freeze({
          attempt: input.attempt.attempt,
          attemptId: input.attempt.attemptId,
          runId: input.attempt.request.runId,
          sessionId: input.attempt.request.sessionId,
        });
        const row = await deps.queries.attemptByRunId(snapshot.runId);
        const exactReceipt =
          row !== undefined &&
          input.attempt.workItemId === snapshot.attempt.workItemId &&
          input.attempt.attemptId === snapshot.attempt.attemptId &&
          input.attempt.settlementClaimId === connectorSettlementClaimId(snapshot) &&
          exactConnectorAttemptReceipt(
            row,
            snapshot,
            input.attempt.request,
            row.connectorInstallationId,
          );
        if (!exactReceipt) {
          throw new Error("connector settlement denied");
        }
        if (row.status === "succeeded" || row.status === "failed") {
          if (
            row.settlement === undefined ||
            canonicalSemanticValue(row.settlement) !== canonicalSemanticValue(input.settlement)
          ) {
            throw new Error("connector settlement denied");
          }
          if ((row.status === "succeeded") !== (row.settlement.status === "succeeded")) {
            throw new Error("connector settlement denied");
          }
          return row.settlement.status === "succeeded" && row.settlement.result.output !== undefined
            ? Object.freeze({ reflection: row.settlement.result.output })
            : Object.freeze({});
        }
        if (row.status !== "running") {
          throw new Error("connector settlement denied");
        }
        const settlement = input.settlement;
        if (
          settlement.status === "succeeded" &&
          (settlement.result.status !== "succeeded" ||
            settlement.result.runId !== snapshot.runId ||
            settlement.result.sessionId !== snapshot.sessionId)
        ) {
          throw new Error("connector settlement denied");
        }
        const error =
          settlement.status === "failed"
            ? nonEmpty(settlement.error, "connector error")
            : undefined;
        await deps.lifecycle.settleAttempt({
          transitionId: settlement.status === "succeeded" ? "AT-07" : "AT-08",
          attempt: snapshot.attempt,
          ...(error === undefined ? {} : { error }),
          settlement,
          requestId: `connector:settle:${snapshot.attemptId}`,
        });
        return settlement.status === "succeeded" && settlement.result.output !== undefined
          ? Object.freeze({ reflection: settlement.result.output })
          : Object.freeze({});
      },
    }),
    artifacts: Object.freeze({
      async putAndReference(input: ConnectorArtifactInputV1): Promise<void> {
        nonEmpty(input.ownerSessionId, "ownerSessionId");
        nonEmpty(input.artifactId, "artifactId");
        nonEmpty(input.mediaType, "mediaType");
        const bytes = new Uint8Array(input.content);
        const blob: ConnectorContentBlobV1 = Object.freeze({
          bytes,
          ref: Object.freeze({
            version: "content-blob-ref-v1",
            digest: createHash("sha256").update(bytes).digest("hex"),
            byteLength: bytes.byteLength,
            mediaType: input.mediaType,
          }),
        });
        await deps.artifacts.putAndReference({
          transitionId: "AF-01",
          ownerSessionId: input.ownerSessionId,
          artifactId: input.artifactId,
          title: input.title,
          blob,
          requestId: `artifact:${input.artifactId}`,
        });
      },
    }),
  });
}

export interface CredentialProvisioningAttemptRowV1 {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly status:
    | "starting"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  readonly attempt: Ledger.AttemptRefV1;
  readonly model: Model.Ref;
  readonly binding?: ActiveWorkerBindingV1;
}

export interface CredentialProvisioningAuthorizationRowV1 {
  readonly ownerKey: string;
  readonly effectId: string;
  readonly sourceRef: string;
  readonly settlement:
    | "pending"
    | "confirmed"
    | "definite_failed"
    | "unknown"
    | "manually_resolved";
  readonly attempt: Ledger.AttemptRefV1;
  readonly scope: Execution.EffectScopeV1;
}

export interface ProvisioningAuthorizationBindingV1 {
  readonly runtimeId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly principalId: string;
  readonly processId: number;
  readonly runId: string;
  readonly sessionId: string;
  readonly attempt: Ledger.AttemptRefV1;
  readonly nonceRef: string;
  readonly credentialRef: Execution.CredentialSourceRefV1;
}

export interface ProvisioningAuthorizationV1 {
  readonly binding: ProvisioningAuthorizationBindingV1;
  readonly request: Execution.CredentialProvisioningRequestV1;
  readonly effect: CredentialProvisioningAuthorizationRowV1;
  readonly claimId: string;
}

export interface ProductionProvisioningDependencies {
  readonly model: Model.Ref;
  readonly now?: () => number;
  readonly queries: {
    attempt(attemptId: string): Promise<CredentialProvisioningAttemptRowV1 | undefined>;
    authorization(effectId: string): Promise<CredentialProvisioningAuthorizationRowV1 | undefined>;
    credentialRef(providerId: string): Promise<Execution.CredentialSourceRefV1 | undefined>;
  };
  readonly transitions: {
    confirmAttemptRunning(
      input: Readonly<{
        transitionId: "AT-03";
        attempt: Ledger.AttemptRefV1;
        requestId: string;
      }>,
    ): Promise<void>;
  };
}

export interface ProductionProvisioningAuthorizationService {
  authorize(frame: Ipc.CredentialProvisioningFrameV1): Promise<ProvisioningAuthorizationV1>;
  confirm(
    authorization: ProvisioningAuthorizationV1,
    receipt: Ipc.CredentialProvisioningReceiptV1,
    acknowledgement: Ipc.CredentialProvisioningAcknowledgementV1,
  ): Promise<void>;
  release(authorization: ProvisioningAuthorizationV1): void;
}

function compatibleTransferCredential(
  requested: Execution.CredentialSourceRefV1,
  owner: Execution.CredentialSourceRefV1,
): boolean {
  return (
    requested.version === owner.version &&
    requested.providerId === owner.providerId &&
    requested.authType === owner.authType &&
    requested.credentialId === owner.credentialId &&
    requested.account === owner.account &&
    requested.endpointRef === owner.endpointRef &&
    requested.sourceKind === "injected_runtime"
  );
}

function exactProvisioningEffectScope(effect: CredentialProvisioningAuthorizationRowV1): boolean {
  const workItemDigest = createHash("sha256").update(effect.attempt.workItemId).digest("hex");
  const sourceDigest = createHash("sha256").update(effect.sourceRef).digest("hex");
  const scope = Execution.EffectScopeV1.safeParse(effect.scope);
  if (!scope.success) return false;
  const resource = scope.data.resources[0];
  return (
    scope.data.workspace.canonicalizerVersion === "workspace-v1" &&
    scope.data.workspace.workspaceId === `w1:${workItemDigest}` &&
    scope.data.workspace.canonicalBytesDigest === workItemDigest &&
    scope.data.resources.length === 1 &&
    resource?.kind === "registered" &&
    resource.variant === "kernel_effect.v1" &&
    resource.targetDigest === sourceDigest &&
    scope.data.resolver.id === "production-structural-adapter" &&
    scope.data.resolver.version === "1" &&
    scope.data.resolver.inputDigest === sourceDigest &&
    scope.data.containment === "none" &&
    scope.data.mutationClass === "mutating"
  );
}

function freezeProvisioningAuthorization(
  binding: ProvisioningAuthorizationBindingV1,
  request: Execution.CredentialProvisioningRequestV1,
  effect: CredentialProvisioningAuthorizationRowV1,
  claimId: string,
): ProvisioningAuthorizationV1 {
  const frozenRequest = Execution.CredentialProvisioningRequestV1.parse(structuredClone(request));
  const frozenEffect: CredentialProvisioningAuthorizationRowV1 = {
    ...structuredClone(effect),
    attempt: Object.freeze({ ...effect.attempt }),
    scope: Object.freeze(Execution.EffectScopeV1.parse(structuredClone(effect.scope))),
  };
  Object.freeze(frozenRequest.attempt);
  Object.freeze(frozenRequest.providerIds);
  for (const credentialRef of frozenRequest.credentialRefs) Object.freeze(credentialRef);
  Object.freeze(frozenRequest.credentialRefs);
  return Object.freeze({
    binding,
    request: Object.freeze(frozenRequest),
    effect: Object.freeze(frozenEffect),
    claimId,
  });
}

interface PrivateProvisioningClaimV1 {
  readonly authorization: ProvisioningAuthorizationV1;
  readonly authorizedAtDbMs: number;
}

function sameReceipt(
  left: Ipc.CredentialProvisioningReceiptV1,
  right: Ipc.CredentialProvisioningReceiptV1,
): boolean {
  return (
    left.version === right.version &&
    left.runtimeId === right.runtimeId &&
    left.workerId === right.workerId &&
    left.generation === right.generation &&
    left.principalId === right.principalId &&
    sameAttempt(left.attempt, right.attempt) &&
    left.nonceRef === right.nonceRef &&
    left.acceptedAtDbMs === right.acceptedAtDbMs &&
    left.acceptedCredentialDigests.length === right.acceptedCredentialDigests.length &&
    left.acceptedCredentialDigests.every(
      (digest, index) => digest === right.acceptedCredentialDigests[index],
    )
  );
}

function exactProvisioningBinding(
  request: Execution.CredentialProvisioningRequestV1,
  channel: Ipc.CredentialProvisioningFrameV1["channelIdentity"],
  row: CredentialProvisioningAttemptRowV1,
): boolean {
  const binding = row.binding;
  if (binding === undefined) return false;
  return (
    request.runtimeId === channel.runtimeId &&
    request.workerId === channel.workerId &&
    request.generation === channel.generation &&
    request.principalId === channel.principalId &&
    sameAttempt(request.attempt, channel.attempt) &&
    channel.runtimeId === binding.runtimeId &&
    channel.workerId === binding.workerId &&
    channel.generation === binding.generation &&
    channel.principalId === binding.principalId &&
    channel.processId === binding.processId &&
    channel.runId === row.runId &&
    channel.runId === binding.runId &&
    channel.sessionId === row.sessionId &&
    channel.sessionId === binding.sessionId &&
    sameAttempt(channel.attempt, row.attempt) &&
    sameAttempt(channel.attempt, binding.attempt)
  );
}

function exactProvisioningReceipt(
  receipt: Ipc.CredentialProvisioningReceiptV1,
  request: Execution.CredentialProvisioningRequestV1,
  credentialRef: Execution.CredentialSourceRefV1,
  authorizedAtDbMs: number,
): boolean {
  return (
    receipt.version === "credential-provisioning-receipt-v1" &&
    receipt.runtimeId === request.runtimeId &&
    receipt.workerId === request.workerId &&
    receipt.generation === request.generation &&
    receipt.principalId === request.principalId &&
    sameAttempt(receipt.attempt, request.attempt) &&
    receipt.nonceRef === request.nonceRef &&
    Number.isSafeInteger(receipt.acceptedAtDbMs) &&
    receipt.acceptedAtDbMs >= 0 &&
    receipt.acceptedAtDbMs >= authorizedAtDbMs &&
    receipt.acceptedAtDbMs <= request.expiresAt &&
    receipt.acceptedCredentialDigests.length === 1 &&
    receipt.acceptedCredentialDigests[0] === credentialRef.credentialDigest
  );
}

function exactAcknowledgement(
  acknowledgement: Ipc.CredentialProvisioningAcknowledgementV1,
  channel: Ipc.CredentialProvisioningFrameV1["channelIdentity"],
  receipt: Ipc.CredentialProvisioningReceiptV1,
): boolean {
  return (
    acknowledgement.workerId === channel.workerId &&
    acknowledgement.generation === channel.generation &&
    acknowledgement.processId === channel.processId &&
    acknowledgement.runId === channel.runId &&
    acknowledgement.sessionId === channel.sessionId &&
    sameReceipt(acknowledgement.receipt, receipt)
  );
}

export function createProvisioningAuthorizationService(
  deps: ProductionProvisioningDependencies,
): ProductionProvisioningAuthorizationService {
  const claims = new Map<string, PrivateProvisioningClaimV1>();
  const spentReservations = new Set<string>();
  const now = deps.now ?? Date.now;
  const consumeClaim = (
    authorization: ProvisioningAuthorizationV1,
  ): PrivateProvisioningClaimV1 | undefined => {
    const claim = claims.get(authorization.claimId);
    if (claim !== undefined) claims.delete(authorization.claimId);
    return claim;
  };
  return Object.freeze({
    async authorize(
      frame: Ipc.CredentialProvisioningFrameV1,
    ): Promise<ProvisioningAuthorizationV1> {
      const parsed = Execution.CredentialProvisioningRequestV1.safeParse(frame.request);
      if (!parsed.success) throw new Error("credential provisioning denied");
      const request = parsed.data;
      const providerId = request.providerIds.length === 1 ? request.providerIds[0] : undefined;
      const requestedCredentialRef =
        request.credentialRefs.length === 1 ? request.credentialRefs[0] : undefined;
      if (providerId === undefined || requestedCredentialRef === undefined) {
        throw new Error("credential provisioning denied");
      }
      const [attempt, effect, ownerCredentialRef] = await Promise.all([
        deps.queries.attempt(request.attempt.attemptId),
        deps.queries.authorization(`credential-provisioning:${request.attempt.attemptId}`),
        deps.queries.credentialRef(providerId),
      ]);
      if (
        attempt === undefined ||
        effect === undefined ||
        ownerCredentialRef === undefined ||
        request.expiresAt <= now() ||
        attempt.status !== "starting" ||
        attempt.model.provider !== deps.model.provider ||
        attempt.model.id !== deps.model.id ||
        !exactProvisioningBinding(request, frame.channelIdentity, attempt) ||
        effect.ownerKey !== attempt.ownerKey ||
        effect.ownerKey !== `work:${request.attempt.workItemId}` ||
        effect.effectId !== `credential-provisioning:${request.attempt.attemptId}` ||
        effect.sourceRef !== effect.effectId ||
        effect.settlement !== "pending" ||
        !sameAttempt(effect.attempt, request.attempt) ||
        !exactProvisioningEffectScope(effect) ||
        providerId !== deps.model.provider ||
        !compatibleTransferCredential(requestedCredentialRef, ownerCredentialRef)
      ) {
        throw new Error("credential provisioning denied");
      }
      const channel = frame.channelIdentity;
      const binding: ProvisioningAuthorizationBindingV1 = Object.freeze({
        runtimeId: channel.runtimeId,
        workerId: channel.workerId,
        generation: channel.generation,
        principalId: channel.principalId,
        processId: channel.processId,
        runId: channel.runId,
        sessionId: channel.sessionId,
        attempt: Object.freeze({ ...channel.attempt }),
        nonceRef: request.nonceRef,
        credentialRef: Object.freeze({ ...requestedCredentialRef }),
      });
      const reservationKey = [
        effect.effectId,
        binding.runtimeId,
        binding.workerId,
        String(binding.generation),
        binding.attempt.workItemId,
        binding.attempt.attemptId,
        String(binding.attempt.attemptSeq),
      ].join("\0");
      if (spentReservations.has(reservationKey)) throw new Error("credential provisioning denied");
      spentReservations.add(reservationKey);
      const claimId = randomBytes(32).toString("hex");
      const privateAuthorization = freezeProvisioningAuthorization(
        binding,
        request,
        effect,
        claimId,
      );
      const exposedAuthorization = freezeProvisioningAuthorization(
        binding,
        request,
        effect,
        claimId,
      );
      claims.set(
        claimId,
        Object.freeze({ authorization: privateAuthorization, authorizedAtDbMs: now() }),
      );
      return exposedAuthorization;
    },
    async confirm(
      authorization: ProvisioningAuthorizationV1,
      receipt: Ipc.CredentialProvisioningReceiptV1,
      acknowledgement: Ipc.CredentialProvisioningAcknowledgementV1,
    ): Promise<void> {
      const claim = consumeClaim(authorization);
      if (claim === undefined) throw new Error("credential provisioning denied");
      const snapshot = claim.authorization;
      if (
        !exactProvisioningReceipt(
          receipt,
          snapshot.request,
          snapshot.binding.credentialRef,
          claim.authorizedAtDbMs,
        ) ||
        !exactAcknowledgement(acknowledgement, snapshot.binding, receipt)
      ) {
        throw new Error("credential provisioning denied");
      }
      await deps.transitions.confirmAttemptRunning({
        transitionId: "AT-03",
        attempt: snapshot.request.attempt,
        requestId: `credential-provisioning:running:${snapshot.request.attempt.attemptId}`,
      });
    },
    release(authorization: ProvisioningAuthorizationV1): void {
      consumeClaim(authorization);
    },
  });
}

export interface ProductionWorkerConnectorServices {
  readonly worker: ProductionWorkerSemanticPorts;
  readonly connector: ProductionConnectorServices;
  readonly provisioning: ProductionProvisioningAuthorizationService;
}

export function createProductionWorkerConnectorServices(
  input: Readonly<{
    worker: ProductionWorkerSemanticDependencies;
    connector: ProductionConnectorDependencies;
    provisioning: ProductionProvisioningDependencies;
  }>,
): ProductionWorkerConnectorServices {
  return Object.freeze({
    worker: createWorkerSemanticPorts(input.worker),
    connector: createConnectorArtifactServices(input.connector),
    provisioning: createProvisioningAuthorizationService(input.provisioning),
  });
}
