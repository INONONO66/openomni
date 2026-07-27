import { createHash } from "node:crypto";
import type { ChatAgent } from "@openomni/agent";
import { createIpcServer } from "@openomni/coordinator";
import { AgentToolProvider, InjectionQueue, createWorkspaceIdentity } from "@openomni/openomni";
import { AgentProfile, Execution, Ipc, Model, Policy, ToolSelection } from "@openomni/protocol";
import { RuntimeAgentDefinition, WorkerRuntimeDefinition } from "../agents/runtime-definition";
import {
  createP2WorkerCredentialProvisioner,
  decodeP2PrivateProvisioningFrame,
  p2GenerationToken,
  readP2PrivateFdKeyMaterial,
  readP2PrivateProvisioningFrame,
  type P2WorkerCredentialProvisioner,
} from "./p2-worker-provisioning";
import { WorkerBootstrapHandler } from "./worker-bootstrap-handler";
import { WorkerIpcHandlers } from "./worker-ipc-handlers";
import { WorkerRunner } from "./worker-runner";
import type { WorkerRunState } from "./worker-run-state";
import { respondSpawnRejected } from "./worker-runner-types";
import { createPinnedWorkerModelCatalog } from "./worker-runtime";

function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workerId = readCliArg("--worker-id");
const socketPath = readCliArg("--socket");
if (!workerId || !socketPath) {
  console.error("worker-entry: missing required worker identity or socket argument");
  process.exit(1);
}

const inheritedKeyMaterial = readP2PrivateFdKeyMaterial(0);
const generationKey = inheritedKeyMaterial.take();
const ipcAuthToken = p2GenerationToken(generationKey);
const activeRuns: WorkerRunState.ActiveRunRegistry = new Map();
const bootstrapState = WorkerBootstrapHandler.createState();
const injectionQueue = InjectionQueue.create();
let provisioner: P2WorkerCredentialProvisioner | undefined;
let provisioningStarted = false;
let authenticatedConnectionId: string | undefined;

async function shutdownWorker(exitCode: number): Promise<never> {
  try {
    provisioner?.dispose();
  } catch {
    // Cleanup classification is intentionally not written to worker logs.
  }
  generationKey.fill(0);
  inheritedKeyMaterial.dispose();
  server.close();
  process.exit(exitCode);
}

function runtimeDefinition(input: unknown): WorkerRuntimeDefinition {
  const parsed = Ipc.Methods["coordinator.spawn_run"].params.parse(input).runtime;
  if (parsed.config.agents.length !== 1) throw new Error("worker runtime definition denied");
  const candidate = parsed.config.agents[0];
  const allowedAgentKeys = new Set([
    "name",
    "description",
    "model",
    "systemPrompt",
    "tools",
    "permissions",
    "policyPlan",
    "budget",
  ]);
  if (
    candidate === undefined ||
    Object.keys(candidate).some((key) => !allowedAgentKeys.has(key)) ||
    typeof candidate.description !== "string" ||
    typeof candidate.systemPrompt !== "string"
  ) {
    throw new Error("worker runtime definition denied");
  }
  const model = Model.Ref.parse(candidate.model);
  if (model.provider !== parsed.config.model.provider || model.id !== parsed.config.model.id) {
    throw new Error("worker runtime definition denied");
  }
  const agent = RuntimeAgentDefinition.create({
    name: candidate.name,
    description: candidate.description,
    model,
    systemPrompt: candidate.systemPrompt,
    tools: ToolSelection.Selection.strict().parse(candidate.tools),
    ...(candidate.permissions === undefined
      ? {}
      : { permissions: Policy.Permission.parse(candidate.permissions) }),
    ...(candidate.policyPlan === undefined
      ? {}
      : { policyPlan: Policy.PolicyPlan.parse(candidate.policyPlan) }),
    ...(candidate.budget === undefined
      ? {}
      : { budget: AgentProfile.AgentBudget.parse(candidate.budget) }),
  });
  const catalogNames = parsed.config.toolCatalog.map((spec) => spec.name);
  if (
    catalogNames.length !== new Set(catalogNames).size ||
    (agent.tools.allow ?? []).some((name) => !catalogNames.includes(name)) ||
    JSON.stringify(parsed.config.budget) !== JSON.stringify(agent.budget)
  ) {
    throw new Error("worker runtime definition denied");
  }
  return WorkerRuntimeDefinition.create({
    ...parsed,
    config: {
      ...parsed.config,
      agents: [agent],
      toolCatalog: parsed.config.toolCatalog.map((spec) => ({
        canonicalName: spec.name,
        exposedName: spec.name,
        source: "server",
        category: "custom",
        riskTier: 1,
        spec,
      })),
      ...(parsed.config.budget === undefined ? {} : { budget: parsed.config.budget }),
    },
  });
}

async function provisionRuntime(
  runId: string,
  sessionId: string,
  runtime: WorkerRuntimeDefinition,
): Promise<{
  readonly workspaceIdentity: ReturnType<typeof createWorkspaceIdentity>;
  readonly environment: Parameters<typeof ChatAgent.create>[0]["environment"];
}> {
  if (provisioningStarted) throw new Error("credential provisioning denied");
  provisioningStarted = true;
  const bootstrap = bootstrapState.getBootstrap();
  if (
    bootstrap === null ||
    runtime.workerId !== workerId ||
    runtime.runtimeId !== bootstrap.runtimeId ||
    runtime.generation !== bootstrap.generation ||
    runtime.config.configEpoch !== bootstrap.configEpoch
  ) {
    throw new Error("credential provisioning denied");
  }
  const credentialRef = runtime.config.environment.credential;
  if (credentialRef.providerId !== runtime.config.model.provider) {
    throw new Error("credential provisioning denied");
  }
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  let nonceRef: string;
  try {
    nonceRef = createHash("sha256").update(nonceBytes).digest("hex");
  } finally {
    nonceBytes.fill(0);
  }
  const request = Execution.CredentialProvisioningRequestV1.parse({
    version: "credential-provisioning-request-v1",
    runtimeId: runtime.runtimeId,
    workerId: runtime.workerId,
    generation: runtime.generation,
    principalId: runtime.principalId,
    attempt: runtime.attempt,
    providerIds: [runtime.config.model.provider],
    nonceRef,
    expiresAt: Date.now() + 30_000,
    credentialRefs: [credentialRef],
  });
  const receipt = Ipc.Methods["worker.credential_provision"].result.parse(
    await server.call("worker.credential_provision", {
      workerId,
      generation: runtime.generation,
      runId,
      sessionId,
      request,
    }),
  );
  const privateBytes = readP2PrivateProvisioningFrame(0);
  let decoded: ReturnType<typeof decodeP2PrivateProvisioningFrame>;
  try {
    decoded = decodeP2PrivateProvisioningFrame(privateBytes);
  } finally {
    privateBytes.fill(0);
  }
  provisioner = createP2WorkerCredentialProvisioner({
    runtimeId: runtime.runtimeId,
    workerId: runtime.workerId,
    generation: runtime.generation,
    principalId: runtime.principalId,
    attempt: runtime.attempt,
    nonceRef,
    providerIds: request.providerIds,
    credentialRefs: request.credentialRefs,
    keyMaterial: {
      take: () => generationKey,
      dispose: () => inheritedKeyMaterial.dispose(),
    },
    nonces: {
      consume(candidate) {
        return candidate === nonceRef;
      },
    },
    nowDbMs: () => receipt.acceptedAtDbMs,
  });
  await WorkerRunner.acknowledgeCredentialProvisioning({
    provisioner,
    frame: { request, ...decoded },
    receipt,
    scrubbedBuffers: [
      privateBytes,
      generationKey,
      decoded.authenticationTag,
      ...decoded.credentials.flatMap((credential) =>
        credential.secret === undefined ? [] : [credential.secret],
      ),
    ],
    server,
    workerId: runtime.workerId,
    generation: runtime.generation,
    processId: process.pid,
    runId,
    sessionId,
  });
  const workspaceIdentity = createWorkspaceIdentity(process.cwd());
  if (
    workspaceIdentity.workspaceId !== runtime.config.workspace.workspaceId ||
    workspaceIdentity.canonicalBytesDigest !== runtime.config.workspace.canonicalBytesDigest
  ) {
    provisioner.dispose();
    throw new Error("worker workspace identity does not match the provisioned runtime");
  }
  return {
    workspaceIdentity,
    environment: {
      reference: runtime.config.environment,
      credential: provisioner.credentialHandle(runtime.config.model.provider),
      secrets: provisioner.registry,
      sanitizer: provisioner.sanitizer,
    },
  };
}

const server = createIpcServer(socketPath, (method, params, respond, _notify, connectionId) => {
  if (method === "coordinator.bootstrap") {
    const wasUnbootstrapped = bootstrapState.getBootstrap() === null;
    WorkerBootstrapHandler.handleBootstrap({
      params,
      ipcAuthToken,
      workerId,
      server,
      connectionId,
      respond,
      state: bootstrapState,
    });
    if (wasUnbootstrapped && bootstrapState.getBootstrap() !== null) {
      authenticatedConnectionId = connectionId;
    }
    return;
  }

  if (connectionId !== authenticatedConnectionId || params?.authToken !== ipcAuthToken) {
    const error = "unauthorized coordinator request";
    if (method === "coordinator.spawn_run") {
      respondSpawnRejected({ params, respond, error });
    } else if (method === "coordinator.cancel_run") {
      respond({ cancelled: false, error });
    } else if (method === "worker.deliver_message") {
      respond({ accepted: false, error });
    } else if (method === "worker.shutdown_idle") {
      respond({ acknowledged: false, error });
    }
    return;
  }

  if (method === "coordinator.spawn_run") {
    void (async () => {
      try {
        const runtime = runtimeDefinition(params);
        const dependencies = await provisionRuntime(
          params.runId as string,
          params.sessionId as string,
          runtime,
        );
        const agent = runtime.config.agents[0];
        if (agent === undefined) throw new Error("credential provisioning denied");
        const requestParams = {
          authToken: params.authToken as string,
          runId: params?.runId,
          sessionId: params?.sessionId,
          mode: "direct" as const,
          prompt: params?.prompt,
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          permissions: agent.permissions,
          policyPlan: agent.policyPlan,
          agentName: agent.name,
          budget: agent.budget,
        };
        WorkerRunner.spawnRun({
          params: requestParams,
          respond,
          ipcAuthToken,
          workerId,
          server,
          activeRuns,
          injectionQueue,
          runtime,
          workspaceIdentity: dependencies.workspaceIdentity,
          environment: dependencies.environment,
          modelCatalog: createPinnedWorkerModelCatalog({
            model: runtime.config.model,
            environment: runtime.config.environment,
          }),
          createAgentToolProvider: (options) =>
            new AgentToolProvider(options as ConstructorParameters<typeof AgentToolProvider>[0]),
          onSettled: () => {
            provisioner?.dispose();
            setTimeout(() => void shutdownWorker(0), 0);
          },
        });
      } catch {
        provisioner?.dispose();
        respondSpawnRejected({ params, respond, error: "credential provisioning denied" });
        setTimeout(() => void shutdownWorker(1), 0);
      }
    })();
  } else if (method === "coordinator.cancel_run") {
    respond(WorkerIpcHandlers.cancelRun({ params, ipcAuthToken, activeRuns }));
  } else if (method === "worker.deliver_message") {
    respond(
      WorkerIpcHandlers.deliverMessage({
        params,
        ipcAuthToken,
        workerId,
        activeRuns,
        injectionQueue,
      }),
    );
  } else if (method === "worker.shutdown_idle") {
    const result = WorkerIpcHandlers.canShutdownIdle({ params, ipcAuthToken, activeRuns });
    respond(result);
    if (result.acknowledged) setTimeout(() => void shutdownWorker(0), 0);
  } else {
    respond({ ok: false, error: `unsupported worker IPC method: ${method}` });
  }
});

process.on("SIGTERM", () => {
  void shutdownWorker(0);
});
