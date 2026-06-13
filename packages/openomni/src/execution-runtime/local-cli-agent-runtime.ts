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

export type { LocalCliCredentialMap } from "./local-cli-agent-env.js";

export interface LocalCliAgentRuntimeDispatchInput {
  readonly command: Dispatch.Command;
  readonly executionRequest: Execution.Request;
  readonly installation: AppConnector.Installation;
}

export interface LocalCliAgentRuntimeOptions {
  readonly credentials?: LocalCliCredentialMap;
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
): string | undefined {
  const finalMessage = installation.definition.evidence.completionReport?.finalMessage ?? "stdout";
  if (finalMessage === "stderr") return trimOutput(outcome.stderr);
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

async function runSpawn(
  spawn: AppConnector.Spawn,
  questionBridge: AppConnector.QuestionBridge | undefined,
  values: LocalCliTemplateValues,
  credentialEnv: Record<string, string>,
): Promise<SpawnOutcome> {
  let timedOut = false;
  const timeoutMs = spawn.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const proc = Bun.spawn(
      [renderLocalCliTemplate(spawn.command, values), ...renderLocalCliArgs(spawn, values)],
      {
        cwd: renderLocalCliCwd(spawn, values),
        detached: true,
        env: renderLocalCliEnv(spawn, questionBridge, values, credentialEnv),
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
          status: "interrupted",
          stdout,
          stderr: stderr || `local CLI process timed out after ${timeoutMs}ms`,
        };
      }
      return {
        status: exitCode === 0 ? "succeeded" : "failed",
        stdout,
        stderr,
        exitCode,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof Error) {
      return {
        status: "failed",
        stdout: "",
        stderr: "",
        error: error.message,
      };
    }
    throw error;
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
      const outcome = redactOutcome(
        await runSpawn(
          input.installation.definition.spawn,
          input.installation.definition.questionBridge,
          values,
          credentialEnv.env,
        ),
        credentialEnv.redactions,
      );
      const output = buildOutput(input.installation, outcome);
      const error = buildError(outcome);
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: outcome.status,
        finishReason: buildFinishReason(outcome),
        ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error }),
      };
    },
  };
}
