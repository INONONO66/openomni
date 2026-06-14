import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import {
  type ConnectorEndpointCredentialMap,
  redactConnectorCredentialValues,
  resolveConnectorCredentialEnv,
} from "./env.js";
import { ingestConnectorLogs, type ConnectorLogIngestion } from "../../src/connector/log.js";
import { runConnectorProcess, type ConnectorProcessOutcome } from "./process.js";
import type { ConnectorQuestionBridgeHandler } from "../../src/connector/question-bridge.js";
import { applyConnectorReadBackBuilders } from "./read-back-builder.js";

export type { ConnectorEndpointCredentialMap } from "./env.js";
export type { ConnectorQuestionBridgeHandler } from "../../src/connector/question-bridge.js";

export interface ConnectorEndpointProcessDriverInput {
  readonly command: Dispatch.Command;
  readonly executionRequest: Execution.Request;
  readonly installation: AppConnector.Installation;
}

export interface ConnectorEndpointProcessDriverOptions {
  readonly credentials?: ConnectorEndpointCredentialMap;
  readonly questionBridge?: ConnectorQuestionBridgeHandler;
}

export interface ConnectorEndpointProcessDriver {
  dispatch(input: ConnectorEndpointProcessDriverInput): Promise<Execution.Result>;
}

function trimOutput(value: string): string | undefined {
  const output = value.trim();
  return output.length === 0 ? undefined : output;
}

function buildOutput(
  installation: AppConnector.Installation,
  outcome: ConnectorProcessOutcome,
  logIngestion: ConnectorLogIngestion,
): string | undefined {
  const finalMessage = installation.definition.evidence.completionReport?.finalMessage ?? "stdout";
  if (finalMessage === "stderr") return trimOutput(outcome.stderr);
  if (finalMessage === "log") return trimOutput(logIngestion.finalMessage ?? "");
  return trimOutput(outcome.stdout);
}

function buildError(outcome: ConnectorProcessOutcome): string | undefined {
  if (outcome.error !== undefined) return outcome.error;
  const stderr = outcome.stderr.trim();
  if (outcome.status === "interrupted") {
    return stderr || "connector process timed out";
  }
  if (outcome.status === "failed") {
    const exit = outcome.exitCode === undefined ? "unknown" : String(outcome.exitCode);
    return stderr
      ? `${stderr}\nconnector process exited with code ${exit}`
      : `connector process exited with code ${exit}`;
  }
  return stderr.length === 0 ? undefined : stderr;
}

function buildFinishReason(outcome: ConnectorProcessOutcome): string {
  if (outcome.exitCode !== undefined) return `exit_code:${outcome.exitCode}`;
  if (outcome.status === "interrupted") return outcome.interruptionReason ?? "timeout";
  return "spawn_error";
}

function redactOutcome(
  outcome: ConnectorProcessOutcome,
  redactions: readonly string[],
): ConnectorProcessOutcome {
  if (redactions.length === 0) return outcome;
  return {
    ...outcome,
    stdout: redactConnectorCredentialValues(outcome.stdout, redactions),
    stderr: redactConnectorCredentialValues(outcome.stderr, redactions),
    ...(outcome.error === undefined
      ? {}
      : { error: redactConnectorCredentialValues(outcome.error, redactions) }),
  };
}

function resolveResidentSessionId(command: Dispatch.Command, request: Execution.Request): string {
  return command.target.parentSessionId ?? command.actor.sessionId ?? request.sessionId;
}

export function createConnectorEndpointProcessDriver(
  options: ConnectorEndpointProcessDriverOptions = {},
): ConnectorEndpointProcessDriver {
  return {
    async dispatch(input): Promise<Execution.Result> {
      const request = input.executionRequest;
      const worktree = request.workspaceRoot;
      if (worktree === undefined || worktree.length === 0) {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "failed",
          finishReason: "worktree_unavailable",
          error: "connector endpoint process driver requires workspaceRoot worktree",
        };
      }
      const values = {
        prompt: request.prompt,
        worktree,
        runId: request.runId,
        sessionId: request.sessionId,
      };
      const credentialEnv = resolveConnectorCredentialEnv(
        input.installation,
        options.credentials ?? {},
      );
      if (!credentialEnv.ok) {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "failed",
          finishReason: "credential_unavailable",
          error: credentialEnv.error,
        };
      }
      const spawned = await runConnectorProcess(
        input.installation.definition.spawn,
        input.installation.definition.logs,
        input.installation.definition.questionBridge,
        values,
        credentialEnv.env,
        options.questionBridge,
        resolveResidentSessionId(input.command, request),
      );
      const redactions = [...credentialEnv.redactions, ...spawned.redactions];
      const outcome = redactOutcome(spawned.outcome, redactions);
      const logIngestion = await ingestConnectorLogs({
        connector: input.installation.definition,
        runId: request.runId,
        sessionId: request.sessionId,
        values,
        redactions,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      });
      const output = buildOutput(input.installation, outcome, logIngestion);
      const builtOutput =
        outcome.status === "succeeded"
          ? applyConnectorReadBackBuilders({
              connector: input.installation.definition,
              output,
              values,
            })
          : { ok: true as const, output };
      if (!builtOutput.ok) {
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "failed",
          finishReason: "read_back_request_builder_failed",
          error: builtOutput.error,
        };
      }
      const error = buildError(outcome);
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: outcome.status,
        finishReason: buildFinishReason(outcome),
        ...(builtOutput.output === undefined ? {} : { output: builtOutput.output }),
        ...(error === undefined ? {} : { error }),
        ...(logIngestion.usage === undefined ? {} : { usage: logIngestion.usage }),
        ...(logIngestion.artifacts.length === 0 ? {} : { artifacts: logIngestion.artifacts }),
        ...(logIngestion.logEvents.length === 0 ? {} : { logEvents: logIngestion.logEvents }),
      };
    },
  };
}
