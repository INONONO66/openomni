import type { AppConnector, Dispatch, Execution, Model, WorkItem } from "@openomni/protocol";
import { AppConnectorInstallationStore, Session, WorkItemStore } from "@openomni/session";
import type { ConnectorEndpointDriverOwner } from "../owners.js";
import {
  projectConnectorCompletion,
  type ConnectorCompletionOptions,
} from "./connector-completion-projector.js";
import { createWorkerSpawnWorkItem, failWorkerSpawnExecutor } from "./worker-work-item.js";

const CONNECTOR_ENDPOINT_EXECUTOR_KIND = "connector_endpoint" satisfies WorkItem.ExecutorKind;

export interface ConnectorEndpointWorkerSpawnPayload {
  readonly prompt: string;
  readonly acceptanceCriteria: string[];
  readonly constraints?: string[];
}

export interface ConnectorEndpointWorkerSpawnOptions extends ConnectorCompletionOptions {
  readonly driver?: ConnectorEndpointDriverOwner;
}

function resolveWorkerAgentName(target: Dispatch.Target): string | undefined {
  return target.connectorInstallationId ?? target.endpointId ?? target.id ?? target.name;
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
  payload: ConnectorEndpointWorkerSpawnPayload,
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

function targetMatchesInstallation(
  installation: AppConnector.Installation,
  target: Dispatch.Target,
): boolean {
  const workerName = resolveWorkerAgentName(target);
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
  target: Dispatch.Target,
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
  command: Dispatch.Command,
  payload: ConnectorEndpointWorkerSpawnPayload,
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
    CONNECTOR_ENDPOINT_EXECUTOR_KIND,
  );
  return failWorkerSpawnExecutor(workItemHash, CONNECTOR_ENDPOINT_EXECUTOR_KIND, reason);
}

export function isConnectorEndpointTarget(target: Dispatch.Target): boolean {
  return target.endpointId !== undefined || target.connectorInstallationId !== undefined;
}

export async function handleConnectorEndpointWorkerSpawn(
  command: Dispatch.Command,
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
  let result: Execution.Result;
  try {
    result = await options.driver.dispatch({
      command,
      executionRequest: request,
      installation,
    });
  } catch (err) {
    await WorkItemStore.fail(workItemHash, err instanceof Error ? err.message : String(err));
    throw err;
  }
  const projection = await projectConnectorCompletion(workItemHash, result, options);
  return {
    output: {
      sessionId: request.sessionId,
      runId: request.runId,
      workItemHash,
      connectorEndpointId: installation.endpointId,
      connectorInstallationId: installation.id,
      connectorId: installation.connectorId,
      result,
      reflection: projection.reflection,
    },
  };
}
