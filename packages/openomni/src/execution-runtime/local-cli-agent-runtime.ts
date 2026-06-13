import { resolve } from "node:path";
import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";

export interface LocalCliAgentRuntimeDispatchInput {
  readonly command: Dispatch.Command;
  readonly executionRequest: Execution.Request;
  readonly installation: AppConnector.Installation;
}

export interface LocalCliAgentRuntime {
  dispatch(input: LocalCliAgentRuntimeDispatchInput): Promise<Execution.Result>;
}

interface TemplateValues {
  readonly prompt: string;
  readonly worktree?: string;
  readonly runId: string;
  readonly sessionId: string;
}

interface SpawnOutcome {
  readonly status: "succeeded" | "failed" | "interrupted";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const templatePattern = /\{\{(prompt|worktree|runId|sessionId)\}\}/g;
const inheritedEnvKeys = ["PATH", "SYSTEMROOT", "SystemRoot", "WINDIR"] as const;

function valueForTemplateKey(key: string, values: TemplateValues): string {
  switch (key) {
    case "prompt":
      return values.prompt;
    case "worktree":
      if (values.worktree === undefined) {
        throw new Error("local CLI spawn template requires workspaceRoot for {{worktree}}");
      }
      return values.worktree;
    case "runId":
      return values.runId;
    case "sessionId":
      return values.sessionId;
    default:
      throw new Error(`unsupported local CLI spawn template key: ${key}`);
  }
}

function renderTemplate(value: string, values: TemplateValues): string {
  return value.replace(templatePattern, (_match, key: string) => valueForTemplateKey(key, values));
}

function renderArgs(spawn: AppConnector.Spawn, values: TemplateValues): readonly string[] {
  return (spawn.args ?? []).map((arg) => renderTemplate(arg, values));
}

function renderEnv(spawn: AppConnector.Spawn, values: TemplateValues): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of inheritedEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (spawn.env === undefined) return env;
  for (const key of Object.keys(spawn.env)) {
    const value = spawn.env[key];
    if (value === undefined) continue;
    env[key] = renderTemplate(value, values);
  }
  return env;
}

function renderCwd(spawn: AppConnector.Spawn, values: TemplateValues): string | undefined {
  if (spawn.cwd === undefined)
    return values.worktree === undefined ? undefined : resolve(values.worktree);
  return resolve(renderTemplate(spawn.cwd, values));
}

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

async function runSpawn(spawn: AppConnector.Spawn, values: TemplateValues): Promise<SpawnOutcome> {
  let timedOut = false;
  const timeoutMs = spawn.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const proc = Bun.spawn([renderTemplate(spawn.command, values), ...renderArgs(spawn, values)], {
      cwd: renderCwd(spawn, values),
      detached: true,
      env: renderEnv(spawn, values),
      stdout: "pipe",
      stderr: "pipe",
    });

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

export function createLocalCliAgentRuntime(): LocalCliAgentRuntime {
  return {
    async dispatch(input): Promise<Execution.Result> {
      const request = input.executionRequest;
      const outcome = await runSpawn(input.installation.definition.spawn, {
        prompt: request.prompt,
        worktree: request.workspaceRoot,
        runId: request.runId,
        sessionId: request.sessionId,
      });
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
