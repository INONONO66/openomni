import type { AppConnector, Dispatch, Execution, Model, WorkItem } from "@openomni/protocol";
import { AppConnectorInstallationStore, Session, WorkItemStore } from "@openomni/session";
import type { LocalCliAgentRuntimeOwner } from "../owners.js";
import {
  ignoreWorkItemReflectionFailure,
  reflectCoordinatorResult,
  type WorkerCompletionOptions,
} from "./worker-completion.js";
import { createWorkerSpawnWorkItem, failWorkerSpawnExecutor } from "./worker-work-item.js";

export const LOCAL_CLI_EXECUTOR_KIND = "local_cli_agent" satisfies WorkItem.ExecutorKind;

export interface LocalCliWorkerSpawnPayload {
  readonly prompt: string;
  readonly acceptanceCriteria: string[];
  readonly constraints?: string[];
}

export interface LocalCliWorkerSpawnOptions extends WorkerCompletionOptions {
  readonly runtime?: LocalCliAgentRuntimeOwner;
}

function resolveWorkerAgentName(target: Dispatch.Target): string | undefined {
  return target.id ?? target.name;
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

function buildRequest(
  command: Dispatch.Command,
  model: Model.Ref,
  payload: LocalCliWorkerSpawnPayload,
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

function matchesLocalCliTarget(
  installation: AppConnector.Installation,
  target: Dispatch.Target,
): boolean {
  const workerName = resolveWorkerAgentName(target);
  if (workerName === undefined) return true;
  return (
    workerName === installation.id ||
    workerName === installation.connectorId ||
    workerName === installation.definition.id ||
    workerName === installation.definition.name
  );
}

function resolveEnabledLocalCliInstallation(
  target: Dispatch.Target,
): AppConnector.Installation | undefined {
  return AppConnectorInstallationStore.list().find(
    (installation) =>
      installation.status === "enabled" &&
      installation.consent !== undefined &&
      installation.definition.profile.executorKind === LOCAL_CLI_EXECUTOR_KIND &&
      matchesLocalCliTarget(installation, target),
  );
}

async function failLocalCliWorkerSpawn(
  command: Dispatch.Command,
  payload: LocalCliWorkerSpawnPayload,
  reason: string,
): Promise<never> {
  const workItemHash = await createWorkerSpawnWorkItem(
    command,
    {
      prompt: payload.prompt,
      agentName: resolveWorkerAgentName(command.target),
      sessionId: command.target.sessionId,
    },
    payload,
    LOCAL_CLI_EXECUTOR_KIND,
  );
  return failWorkerSpawnExecutor(workItemHash, LOCAL_CLI_EXECUTOR_KIND, reason);
}

export async function handleLocalCliWorkerSpawn(
  command: Dispatch.Command,
  model: Model.Ref,
  payload: LocalCliWorkerSpawnPayload,
  options: LocalCliWorkerSpawnOptions,
): Promise<unknown> {
  const installation = resolveEnabledLocalCliInstallation(command.target);
  if (installation === undefined) {
    return failLocalCliWorkerSpawn(
      command,
      payload,
      "worker.spawn executor local_cli_agent requires an enabled AppConnector installation",
    );
  }
  if (options.runtime === undefined) {
    return failLocalCliWorkerSpawn(
      command,
      payload,
      "worker.spawn executor local_cli_agent requires a local CLI runtime owner",
    );
  }

  const request = buildRequest(command, model, payload);
  const workItemHash = await createWorkerSpawnWorkItem(
    command,
    request,
    payload,
    LOCAL_CLI_EXECUTOR_KIND,
  );
  let result: Execution.Result;
  try {
    result = await options.runtime.dispatch({
      command,
      executionRequest: request,
      installation,
    });
  } catch (err) {
    await ignoreWorkItemReflectionFailure(() =>
      WorkItemStore.fail(workItemHash, err instanceof Error ? err.message : String(err)),
    );
    throw err;
  }
  await recordLocalCliArtifacts(workItemHash, result);
  await recordLocalCliLogEvents(workItemHash, result);
  const reflection = await reflectCoordinatorResult(workItemHash, result, {
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
      connectorInstallationId: installation.id,
      connectorId: installation.connectorId,
      result,
      reflection,
    },
  };
}

async function recordLocalCliArtifacts(
  workItemHash: string,
  result: Execution.Result,
): Promise<void> {
  for (const artifact of result.artifacts ?? []) {
    await ignoreWorkItemReflectionFailure(() =>
      WorkItemStore.addEvidence(workItemHash, {
        kind: "custom",
        description: "local CLI log artifact recorded",
        passed: true,
        detail: JSON.stringify(artifact),
      }),
    );
  }
}

async function recordLocalCliLogEvents(
  workItemHash: string,
  result: Execution.Result,
): Promise<void> {
  for (const event of result.logEvents ?? []) {
    await ignoreWorkItemReflectionFailure(() =>
      WorkItemStore.addEvidence(workItemHash, {
        kind: "custom",
        description: "local CLI log event recorded",
        passed: true,
        detail: JSON.stringify(event),
      }),
    );
  }
}
