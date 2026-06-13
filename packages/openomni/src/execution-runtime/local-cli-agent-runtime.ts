import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import {
  type LocalCliCredentialMap,
  redactLocalCliCredentialValues,
  resolveLocalCliCredentialEnv,
} from "./local-cli-agent-env.js";
import { ingestLocalCliLogs, type LocalCliLogIngestion } from "./local-cli-agent-log.js";
import {
  runLocalCliAgentProcess,
  type LocalCliAgentProcessOutcome,
} from "./local-cli-agent-process.js";
import type { LocalCliQuestionBridgeHandler } from "./local-cli-question-bridge.js";

export type { LocalCliCredentialMap } from "./local-cli-agent-env.js";
export type { LocalCliQuestionBridgeHandler } from "./local-cli-question-bridge.js";

export interface LocalCliAgentRuntimeDispatchInput {
  readonly command: Dispatch.Command;
  readonly executionRequest: Execution.Request;
  readonly installation: AppConnector.Installation;
}

export interface LocalCliAgentRuntimeOptions {
  readonly credentials?: LocalCliCredentialMap;
  readonly questionBridge?: LocalCliQuestionBridgeHandler;
}

export interface LocalCliAgentRuntime {
  dispatch(input: LocalCliAgentRuntimeDispatchInput): Promise<Execution.Result>;
}

function trimOutput(value: string): string | undefined {
  const output = value.trim();
  return output.length === 0 ? undefined : output;
}

function buildOutput(
  installation: AppConnector.Installation,
  outcome: LocalCliAgentProcessOutcome,
  logIngestion: LocalCliLogIngestion,
): string | undefined {
  const finalMessage = installation.definition.evidence.completionReport?.finalMessage ?? "stdout";
  if (finalMessage === "stderr") return trimOutput(outcome.stderr);
  if (finalMessage === "log") return trimOutput(logIngestion.finalMessage ?? "");
  return trimOutput(outcome.stdout);
}

function buildError(outcome: LocalCliAgentProcessOutcome): string | undefined {
  if (outcome.error !== undefined) return outcome.error;
  const stderr = outcome.stderr.trim();
  if (outcome.status === "interrupted") {
    return stderr || "local CLI process timed out";
  }
  if (outcome.status === "failed") {
    const exit = outcome.exitCode === undefined ? "unknown" : String(outcome.exitCode);
    return stderr
      ? `${stderr}\nlocal CLI process exited with code ${exit}`
      : `local CLI process exited with code ${exit}`;
  }
  return stderr.length === 0 ? undefined : stderr;
}

function buildFinishReason(outcome: LocalCliAgentProcessOutcome): string {
  if (outcome.exitCode !== undefined) return `exit_code:${outcome.exitCode}`;
  if (outcome.status === "interrupted") return outcome.interruptionReason ?? "timeout";
  return "spawn_error";
}

function redactOutcome(
  outcome: LocalCliAgentProcessOutcome,
  redactions: readonly string[],
): LocalCliAgentProcessOutcome {
  if (redactions.length === 0) return outcome;
  return {
    ...outcome,
    stdout: redactLocalCliCredentialValues(outcome.stdout, redactions),
    stderr: redactLocalCliCredentialValues(outcome.stderr, redactions),
    ...(outcome.error === undefined
      ? {}
      : { error: redactLocalCliCredentialValues(outcome.error, redactions) }),
  };
}

function resolveResidentSessionId(command: Dispatch.Command, request: Execution.Request): string {
  return command.target.parentSessionId ?? command.actor.sessionId ?? request.sessionId;
}

export function createLocalCliAgentRuntime(
  options: LocalCliAgentRuntimeOptions = {},
): LocalCliAgentRuntime {
  return {
    async dispatch(input): Promise<Execution.Result> {
      const request = input.executionRequest;
      const values = {
        prompt: request.prompt,
        worktree: request.workspaceRoot,
        runId: request.runId,
        sessionId: request.sessionId,
      };
      const credentialEnv = resolveLocalCliCredentialEnv(
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
      const spawned = await runLocalCliAgentProcess(
        input.installation.definition.spawn,
        input.installation.definition.questionBridge,
        values,
        credentialEnv.env,
        options.questionBridge,
        resolveResidentSessionId(input.command, request),
      );
      const redactions = [...credentialEnv.redactions, ...spawned.redactions];
      const outcome = redactOutcome(spawned.outcome, redactions);
      const logIngestion = await ingestLocalCliLogs({
        connector: input.installation.definition,
        runId: request.runId,
        sessionId: request.sessionId,
        values,
        redactions,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      });
      const output = buildOutput(input.installation, outcome, logIngestion);
      const error = buildError(outcome);
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: outcome.status,
        finishReason: buildFinishReason(outcome),
        ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error }),
        ...(logIngestion.usage === undefined ? {} : { usage: logIngestion.usage }),
        ...(logIngestion.artifacts.length === 0 ? {} : { artifacts: logIngestion.artifacts }),
        ...(logIngestion.logEvents.length === 0 ? {} : { logEvents: logIngestion.logEvents }),
      };
    },
  };
}
