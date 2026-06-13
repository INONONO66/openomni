import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import {
  type LocalCliCredentialMap,
  type LocalCliTemplateValues,
  redactLocalCliCredentialValues,
  renderLocalCliArgs,
  renderLocalCliCwd,
  renderLocalCliEnv,
  renderLocalCliTemplate,
  resolveLocalCliCredentialEnv,
} from "./local-cli-agent-env.js";
import { ingestLocalCliLogs, type LocalCliLogIngestion } from "./local-cli-agent-log.js";
import {
  startLocalCliQuestionBridgeServer,
  type LocalCliQuestionBridgeHandler,
} from "./local-cli-question-bridge.js";

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

interface SpawnOutcome {
  readonly status: "succeeded" | "failed" | "interrupted";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 600_000;

function terminateProcess(proc: { readonly pid: number; kill(): void }): void {
  try {
    process.kill(-proc.pid, "SIGTERM");
    return;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  proc.kill();
}

function trimOutput(value: string): string | undefined {
  const output = value.trim();
  return output.length === 0 ? undefined : output;
}

function buildOutput(
  installation: AppConnector.Installation,
  outcome: SpawnOutcome,
  logIngestion: LocalCliLogIngestion,
): string | undefined {
  const finalMessage = installation.definition.evidence.completionReport?.finalMessage ?? "stdout";
  if (finalMessage === "stderr") return trimOutput(outcome.stderr);
  if (finalMessage === "log") return trimOutput(logIngestion.finalMessage ?? "");
  return trimOutput(outcome.stdout);
}

function buildError(outcome: SpawnOutcome): string | undefined {
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

function buildFinishReason(outcome: SpawnOutcome): string {
  if (outcome.exitCode !== undefined) return `exit_code:${outcome.exitCode}`;
  if (outcome.status === "interrupted") return "timeout";
  return "spawn_error";
}

function redactOutcome(outcome: SpawnOutcome, redactions: readonly string[]): SpawnOutcome {
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

function questionBridgeEnabled(questionBridge: AppConnector.QuestionBridge | undefined): boolean {
  return questionBridge !== undefined && questionBridge.kind !== "none";
}

function effectiveQuestionBridge(
  questionBridge: AppConnector.QuestionBridge | undefined,
  bridgeStarted: boolean,
): AppConnector.QuestionBridge | undefined {
  if (!questionBridgeEnabled(questionBridge)) return questionBridge;
  return bridgeStarted ? questionBridge : { kind: "none" };
}

async function runSpawn(
  spawn: AppConnector.Spawn,
  questionBridge: AppConnector.QuestionBridge | undefined,
  values: LocalCliTemplateValues,
  credentialEnv: Record<string, string>,
  questionBridgeHandler: LocalCliQuestionBridgeHandler | undefined,
  residentSessionId: string,
): Promise<{ readonly outcome: SpawnOutcome; readonly redactions: readonly string[] }> {
  let timedOut = false;
  const timeoutMs = spawn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bridge = questionBridgeEnabled(questionBridge)
    ? startLocalCliQuestionBridgeServer({
        runId: values.runId,
        sessionId: values.sessionId,
        residentSessionId,
        handler: questionBridgeHandler,
      })
    : undefined;
  const renderedQuestionBridge = effectiveQuestionBridge(questionBridge, bridge !== undefined);

  try {
    const proc = Bun.spawn(
      [renderLocalCliTemplate(spawn.command, values), ...renderLocalCliArgs(spawn, values)],
      {
        cwd: renderLocalCliCwd(spawn, values),
        detached: true,
        env: renderLocalCliEnv(spawn, renderedQuestionBridge, values, credentialEnv, bridge?.env),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(proc);
    }, timeoutMs);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut) {
        return {
          outcome: {
            status: "interrupted",
            stdout,
            stderr: stderr || `local CLI process timed out after ${timeoutMs}ms`,
          },
          redactions: bridge?.redactions ?? [],
        };
      }
      return {
        outcome: {
          status: exitCode === 0 ? "succeeded" : "failed",
          stdout,
          stderr,
          exitCode,
        },
        redactions: bridge?.redactions ?? [],
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof Error) {
      return {
        outcome: {
          status: "failed",
          stdout: "",
          stderr: "",
          error: error.message,
        },
        redactions: bridge?.redactions ?? [],
      };
    }
    throw error;
  } finally {
    bridge?.close();
  }
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
      const spawned = await runSpawn(
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
        ...(logIngestion.artifacts.length === 0 ? {} : { artifacts: logIngestion.artifacts }),
      };
    },
  };
}
