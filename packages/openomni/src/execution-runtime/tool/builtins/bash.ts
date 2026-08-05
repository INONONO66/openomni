import { resolve } from "node:path";
import { defineTool } from "../define.js";
import { optionalPositiveNumber, optionalString, requireString } from "../shared/input.js";
import { errorResult, fromError, successResult } from "../shared/result.js";
import type { NativeTool, ToolExecutionContext } from "../types.js";
import { BASH_PROMPT } from "./bash-prompt.js";
import { isDestructiveCommand, isReadOnlyCommand, readCommandFromMeta } from "./bash-classify.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_REAP_INTERVAL_MS = 5;

const bashEnvKeys = ["PATH", "TMPDIR", "TEMP", "TMP", "BUN_INSTALL"];

interface BashInput {
  command: string;
  workdir?: string;
  timeoutMs?: number;
}

function resolveWorkingDirectory(
  workspaceRoot: string | undefined,
  requestedWorkdir?: string,
): string {
  const root = workspaceRoot ? resolve(workspaceRoot) : undefined;
  const cwd = requestedWorkdir
    ? resolve(root ?? process.cwd(), requestedWorkdir)
    : (root ?? process.cwd());

  if (!root) return cwd;

  if (cwd !== root && !cwd.startsWith(`${root}/`)) {
    throw new Error(`Working directory must stay within workspace root: ${root}`);
  }

  return cwd;
}

function resolveTimeout(input: Record<string, unknown>): number {
  const value = optionalPositiveNumber(input, "timeoutMs");
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(value, MAX_TIMEOUT_MS);
}

async function terminateProcessGroup(proc: {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(): void;
}): Promise<void> {
  try {
    process.kill(-proc.pid, "SIGTERM");
    if (await waitForProcessGroupExit(proc.pid, PROCESS_TERMINATION_GRACE_MS)) {
      await proc.exited.catch(() => undefined);
      return;
    }
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The whole group exited during the graceful termination window.
    }
    await proc.exited.catch(() => undefined);
    await waitForProcessGroupExit(proc.pid, PROCESS_TERMINATION_GRACE_MS);
    return;
  } catch {
    // Windows and non-detached fallback.
  }

  proc.kill();
  await proc.exited.catch(() => undefined);
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_REAP_INTERVAL_MS));
  }
  return false;
}

function buildBashEnv(workspaceRoot: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of bashEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = workspaceRoot ? resolve(workspaceRoot) : process.cwd();
  return env;
}

export function bashTool(workspaceRoot?: string): NativeTool {
  return defineTool<BashInput>({
    name: "bash",
    description: "Execute a bash command inside the workspace and return combined output",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        workdir: {
          type: "string",
          description: "Working directory, relative to the workspace root",
        },
        timeoutMs: {
          type: "number",
          description: `Command timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
        },
      },
      required: ["command"],
    },
    prompt: BASH_PROMPT,
    riskTier: 2,
    isReadOnly: (input) => isReadOnlyCommand(readCommandFromMeta(input)),
    isDestructive: (input) => isDestructiveCommand(readCommandFromMeta(input)),
    isConcurrencySafe: false,
    source: "system",
    async execute(call, context?: ToolExecutionContext) {
      let timedOut = false;
      let aborted = false;

      try {
        const command = requireString(call.input, "command");
        const cwd = resolveWorkingDirectory(workspaceRoot, optionalString(call.input, "workdir"));
        const timeoutMs = resolveTimeout(call.input);

        if (context?.signal?.aborted) {
          return errorResult(call, "Command aborted");
        }

        const proc = Bun.spawn(["bash", "-lc", command], {
          cwd,
          detached: true,
          env: buildBashEnv(workspaceRoot),
          stdout: "pipe",
          stderr: "pipe",
        });
        let termination: Promise<void> | undefined;

        const abortCommand = () => {
          aborted = true;
          termination ??= terminateProcessGroup(proc);
        };
        context?.signal?.addEventListener("abort", abortCommand, { once: true });

        const timer = setTimeout(() => {
          timedOut = true;
          termination ??= terminateProcessGroup(proc);
        }, timeoutMs);

        try {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          await termination;

          const output = [stdout, stderr]
            .filter((chunk) => chunk.length > 0)
            .join("\n")
            .trim();

          if (aborted) {
            return errorResult(call, output || "Command aborted");
          }

          if (timedOut) {
            return errorResult(call, output || `Command timed out after ${timeoutMs}ms`);
          }

          if (exitCode !== 0) {
            return errorResult(call, output || `Command exited with code ${exitCode}`);
          }

          return successResult(call, output);
        } finally {
          clearTimeout(timer);
          context?.signal?.removeEventListener("abort", abortCommand);
        }
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}
