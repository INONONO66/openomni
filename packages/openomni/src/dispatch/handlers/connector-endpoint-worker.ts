import type { AppConnector, Dispatch, Execution, Model } from "@openomni/protocol";
import type { ConnectorEndpointDriverOwner } from "../owners.js";

export interface ConnectorEndpointWorkerSpawnPayload {
  readonly prompt: string;
  readonly acceptanceCriteria: string[];
  readonly constraints?: string[];
}

export interface ConnectorAttemptProjection {
  readonly workItemId: string;
  readonly attemptId: string;
  readonly request: Execution.Request;
  readonly settlementClaimId: string;
}

export interface ConnectorAttemptSettlement {
  readonly reflection?: unknown;
}

export type ConnectorAttemptSettlementResult =
  | Readonly<{ status: "succeeded"; result: Execution.Result }>
  | Readonly<{ status: "failed"; error: string }>;

export type ConnectorAttemptBeginResult =
  | Readonly<{ disposition: "new"; attempt: ConnectorAttemptProjection }>
  | Readonly<{
      disposition: "in_progress_or_unknown";
      attempt: ConnectorAttemptProjection;
    }>
  | Readonly<{
      disposition: "terminal_replay";
      attempt: ConnectorAttemptProjection;
      settlement: ConnectorAttemptSettlementResult;
    }>;

export interface ConnectorEndpointKernelQueries {
  resolveInstallation(target: Dispatch.Target): Promise<AppConnector.Installation | undefined>;
}

export interface ConnectorEndpointKernelTransitions {
  /** Atomically opens the Session, creates Work, allocates the Attempt, and requests its start. */
  beginAttempt(input: {
    readonly command: Dispatch.Command;
    readonly model: Model.Ref;
    readonly payload: ConnectorEndpointWorkerSpawnPayload;
    readonly installation: AppConnector.Installation;
  }): Promise<ConnectorAttemptBeginResult>;
  /** Records the native Attempt terminal edge and Work/Completion projection consequences. */
  settleAttempt(input: {
    readonly attempt: ConnectorAttemptProjection;
    readonly settlement: ConnectorAttemptSettlementResult;
  }): Promise<ConnectorAttemptSettlement>;
}

interface NativeConnectorEndpointDriverOwner extends ConnectorEndpointDriverOwner {
  readonly kernelQueries: ConnectorEndpointKernelQueries;
  readonly kernelTransitions: ConnectorEndpointKernelTransitions;
}

export interface ConnectorEndpointWorkerSpawnOptions {
  readonly driver?: ConnectorEndpointDriverOwner;
}

function targetMatchesInstallation(
  installation: AppConnector.Installation,
  target: Dispatch.Target,
): boolean {
  return (
    target.kind === "worker" &&
    target.connectorInstallationId === installation.id &&
    target.endpointId === installation.endpointId
  );
}

function requireNativeDriver(
  driver: ConnectorEndpointDriverOwner | undefined,
): NativeConnectorEndpointDriverOwner {
  if (driver === undefined) {
    throw new Error("worker.spawn connector endpoint requires a connector driver owner");
  }
  const candidate = driver as Partial<NativeConnectorEndpointDriverOwner>;
  if (
    candidate.kernelQueries === undefined ||
    typeof candidate.kernelQueries.resolveInstallation !== "function" ||
    candidate.kernelTransitions === undefined ||
    typeof candidate.kernelTransitions.beginAttempt !== "function" ||
    typeof candidate.kernelTransitions.settleAttempt !== "function"
  ) {
    throw new Error("worker.spawn connector endpoint requires native kernel capabilities");
  }
  return candidate as NativeConnectorEndpointDriverOwner;
}

function isEnabledConnectorEndpoint(
  installation: AppConnector.Installation | undefined,
  target: Dispatch.Target,
): installation is AppConnector.Installation {
  return (
    installation !== undefined &&
    installation.status === "enabled" &&
    installation.consent !== undefined &&
    installation.definition.profile.kind === "connector_endpoint" &&
    targetMatchesInstallation(installation, target)
  );
}

export function isConnectorEndpointTarget(target: Dispatch.Target): boolean {
  return (
    target.kind === "worker" &&
    target.endpointId !== undefined &&
    target.connectorInstallationId !== undefined
  );
}

function connectorOutput(
  attempt: ConnectorAttemptProjection,
  installation: AppConnector.Installation,
  result: Execution.Result,
  reflection?: unknown,
): unknown {
  return {
    output: {
      sessionId: attempt.request.sessionId,
      runId: attempt.request.runId,
      workItemHash: attempt.workItemId,
      attemptId: attempt.attemptId,
      connectorEndpointId: installation.endpointId,
      connectorInstallationId: installation.id,
      connectorId: installation.connectorId,
      result,
      ...(reflection === undefined ? {} : { reflection }),
    },
  };
}

export async function handleConnectorEndpointWorkerSpawn(
  command: Dispatch.Command,
  model: Model.Ref,
  payload: ConnectorEndpointWorkerSpawnPayload,
  options: ConnectorEndpointWorkerSpawnOptions,
): Promise<unknown> {
  const driver = requireNativeDriver(options.driver);
  const installation = await driver.kernelQueries.resolveInstallation(command.target);
  if (!isEnabledConnectorEndpoint(installation, command.target)) {
    throw new Error(
      "worker.spawn connector endpoint requires an enabled AppConnector installation",
    );
  }

  const begin = await driver.kernelTransitions.beginAttempt({
    command,
    model,
    payload,
    installation,
  });
  const attempt = begin.attempt;
  if (begin.disposition === "in_progress_or_unknown") {
    return {
      output: {
        disposition: begin.disposition,
        reconciliationRequired: true,
        sessionId: attempt.request.sessionId,
        runId: attempt.request.runId,
        workItemHash: attempt.workItemId,
        attemptId: attempt.attemptId,
        connectorEndpointId: installation.endpointId,
        connectorInstallationId: installation.id,
        connectorId: installation.connectorId,
      },
    };
  }
  if (begin.disposition === "terminal_replay") {
    const replayResult: Execution.Result =
      begin.settlement.status === "succeeded"
        ? begin.settlement.result
        : {
            runId: attempt.request.runId,
            sessionId: attempt.request.sessionId,
            status: "failed",
            error: begin.settlement.error,
          };
    return connectorOutput(
      attempt,
      installation,
      replayResult,
      begin.settlement.status === "succeeded" ? begin.settlement.result.output : undefined,
    );
  }
  let result: Execution.Result;
  try {
    result = await driver.dispatch({
      command,
      executionRequest: attempt.request,
      installation,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await driver.kernelTransitions.settleAttempt({
      attempt,
      settlement: { status: "failed", error: reason },
    });
    throw error;
  }
  const settlement = await driver.kernelTransitions.settleAttempt({
    attempt,
    settlement:
      result.status === "succeeded"
        ? { status: "succeeded", result }
        : { status: "failed", error: result.error ?? `connector execution ${result.status}` },
  });
  return connectorOutput(attempt, installation, result, settlement.reflection);
}
