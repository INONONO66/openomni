import { resolve } from "node:path";
import { defineTool } from "../define.js";
import { optionalPositiveNumber, optionalString, requireString } from "../shared/input.js";
import { errorResult, fromError, successResult } from "../shared/result.js";
import type { NativeTool } from "../types.js";
import { BASH_PROMPT } from "./bash-prompt.js";
import { isDestructiveCommand, isReadOnlyCommand, readCommandFromMeta } from "./bash-classify.js";

export { isReadOnlyCommand, isDestructiveCommand };

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

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
    async execute(call) {
      let timedOut = false;

      try {
        const command = requireString(call.input, "command");
        const cwd = resolveWorkingDirectory(workspaceRoot, optionalString(call.input, "workdir"));
        const timeoutMs = resolveTimeout(call.input);

        const proc = Bun.spawn(["bash", "-lc", command], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });

        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        clearTimeout(timer);

        const output = [stdout, stderr]
          .filter((chunk) => chunk.length > 0)
          .join("\n")
          .trim();

        if (timedOut) {
          return errorResult(call, output || `Command timed out after ${timeoutMs}ms`);
        }

        if (exitCode !== 0) {
          return errorResult(call, output || `Command exited with code ${exitCode}`);
        }

        return successResult(call, output);
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}
