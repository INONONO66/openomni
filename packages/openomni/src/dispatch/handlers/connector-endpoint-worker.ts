import type { AppConnector, Command, Execution, Model, WorkItem } from "@openomni/protocol";
import { AppConnectorInstallationStore, WorkItemStore } from "@openomni/session";
import type { ConnectorEndpointDriverOwner } from "../owners.js";
import {
  projectConnectorCompletion,
  type ConnectorCompletionOptions,
} from "./connector-completion-projector.js";
import { resolveWorkerSessionId } from "./shared.js";
import {
  allocateWorkerSpawnAttempt,
  createWorkerSpawnWorkItem,
  failWorkerSpawnExecutor,
  throwWithWorkItemReflectionFailure,
} from "./worker-work-item.js";

const CONNECTOR_ENDPOINT_EXECUTOR_KIND = "connector_endpoint" satisfies WorkItem.ExecutorKind;

export interface ConnectorEndpointWorkerSpawnPayload {
  readonly prompt: string;
  readonly acceptanceCriteria: string[];
  readonly constraints?: string[];
}

export interface ConnectorEndpointWorkerSpawnOptions extends ConnectorCompletionOptions {
  readonly driver?: ConnectorEndpointDriverOwner;
}

function resolveConnectorWorkerName(target: Command.Target): string | undefined {
  return target.connectorInstallationId ?? target.endpointId ?? target.id ?? target.name;
}

function buildRequest(
  command: Command.Request,
  model: Model.Ref,
  payload: ConnectorEndpointWorkerSpawnPayload,
): Execution.Request {
  const sessionId = resolveWorkerSessionId(command, model);
  return {
    runId: crypto.randomUUID(),
    sessionId,
    mode: "direct",
    prompt: payload.prompt,
    model,
    agentName: resolveConnectorWorkerName(command.target),
    workspaceRoot: command.workspaceRoot,
    traceId: command.traceId,
  };
}

function targetMatchesInstallation(
  installation: AppConnector.Installation,
  target: Command.Target,
): boolean {
  const workerName = resolveConnectorWorkerName(target);
  if (workerName === undefined) return false;
  return (
    workerName === installation.endpointId ||
    workerName === installation.id ||
    workerName === installation.connectorId ||
    workerName === installation.definition.id ||
    workerName === installation.definition.name
  );
}

function resolveEnabledConnectorInstallation(
  target: Command.Target,
): AppConnector.Installation | undefined {
  return AppConnectorInstallationStore.list().find(
    (installation) =>
      installation.status === "enabled" &&
      installation.consent !== undefined &&
      installation.definition.profile.kind === "connector_endpoint" &&
      targetMatchesInstallation(installation, target),
  );
}

async function failConnectorEndpointWorkerSpawn(
  command: Command.Request,
  payload: ConnectorEndpointWorkerSpawnPayload,
  reason: string,
): Promise<never> {
  const workItemHash = await createWorkerSpawnWorkItem(
    command,
    {
      prompt: payload.prompt,
      agentName: resolveConnectorWorkerName(command.target),
      sessionId: command.target.sessionId,
    },
    payload,
    CONNECTOR_ENDPOINT_EXECUTOR_KIND,
  );
  return failWorkerSpawnExecutor(
    workItemHash,
    CONNECTOR_ENDPOINT_EXECUTOR_KIND,
    reason,
    command.traceId,
  );
}

export function isConnectorEndpointTarget(target: Command.Target): boolean {
  return target.endpointId !== undefined || target.connectorInstallationId !== undefined;
}

export async function handleConnectorEndpointWorkerSpawn(
  command: Command.Request,
  model: Model.Ref,
  payload: ConnectorEndpointWorkerSpawnPayload,
  options: ConnectorEndpointWorkerSpawnOptions,
): Promise<unknown> {
  const installation = resolveEnabledConnectorInstallation(command.target);
  if (installation === undefined) {
    return failConnectorEndpointWorkerSpawn(
      command,
      payload,
      "worker.spawn connector endpoint requires an enabled AppConnector installation",
    );
  }
  if (options.driver === undefined) {
    return failConnectorEndpointWorkerSpawn(
      command,
      payload,
      "worker.spawn connector endpoint requires a connector driver owner",
    );
  }

  const request = buildRequest(command, model, payload);
  const workItemHash = await createWorkerSpawnWorkItem(
    command,
    request,
    payload,
    CONNECTOR_ENDPOINT_EXECUTOR_KIND,
  );
  // #510 C2: the attempt identity is appended on the work stream before the
  // connector driver acts; attemptId travels alongside workerRunId. No
  // policy plan is resolved at this gate — the fingerprint lists it absent.
  const attemptId = await allocateWorkerSpawnAttempt(
    workItemHash,
    payload.prompt,
    CONNECTOR_ENDPOINT_EXECUTOR_KIND,
    { model, workspaceRoot: command.workspaceRoot },
    command.traceId,
  );
  let result: Execution.Result;
  try {
    result = await options.driver.dispatch({
      command,
      executionRequest: request,
      installation,
    });
  } catch (err) {
    try {
      await WorkItemStore.fail(
        workItemHash,
        command.traceId,
        err instanceof Error ? err.message : String(err),
      );
    } catch (reflectionFailure) {
      throwWithWorkItemReflectionFailure(err, reflectionFailure);
    }
    throw err;
  }
  const projection = await projectConnectorCompletion(
    workItemHash,
    result,
    options,
    command.traceId,
  );
  return {
    output: {
      sessionId: request.sessionId,
      runId: request.runId,
      workItemHash,
      attemptId,
      connectorEndpointId: installation.endpointId,
      connectorInstallationId: installation.id,
      connectorId: installation.connectorId,
      result,
      reflection: projection.reflection,
    },
  };
}
