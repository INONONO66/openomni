import { resolve } from "node:path";
import type { Tool } from "@openomni/protocol";
import type { NativeTool } from "../../types";

type InputRecord = Record<string, unknown>;

const defaultTimeoutMs = 30_000;

function createResult(call: Tool.Call, output: string, isError?: boolean): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output,
    ...(isError ? { isError } : {}),
  };
}

function getString(input: InputRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid input: ${key} must be a non-empty string`);
  }
  return value;
}

function getOptionalString(input: InputRecord, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid input: ${key} must be a non-empty string`);
  }
  return value;
}

function getTimeout(input: InputRecord): number {
  const value = input.timeoutMs;
  if (value === undefined) return defaultTimeoutMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid input: timeoutMs must be a positive number");
  }
  return value;
}

function resolveWorkingDirectory(
  workspaceRoot: string | undefined,
  requestedWorkdir?: string,
): string {
  const root = workspaceRoot ? resolve(workspaceRoot) : undefined;
  const cwd = requestedWorkdir ? resolve(requestedWorkdir) : (root ?? process.cwd());

  if (!root) {
    return cwd;
  }

  if (cwd !== root && !cwd.startsWith(`${root}/`)) {
    throw new Error(`Working directory must stay within workspace root: ${root}`);
  }

  return cwd;
}

export function createShellTool(workspaceRoot?: string): NativeTool {
  return {
    spec: {
      name: "shell.exec",
      description: "Execute a shell command within the workspace",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          workdir: { type: "string", description: "Working directory" },
          timeoutMs: { type: "number", description: "Command timeout in milliseconds" },
        },
        required: ["command"],
      },
    },
    riskTier: 2,
    async execute(call: Tool.Call): Promise<Tool.Result> {
      let timedOut = false;

      try {
        const command = getString(call.input, "command");
        const workdir = resolveWorkingDirectory(
          workspaceRoot,
          getOptionalString(call.input, "workdir"),
        );
        const timeoutMs = getTimeout(call.input);
        const proc = Bun.spawn(["sh", "-lc", command], {
          cwd: workdir,
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
          return createResult(call, output || `Command timed out after ${timeoutMs}ms`, true);
        }

        if (exitCode !== 0) {
          return createResult(call, output || `Command exited with code ${exitCode}`, true);
        }

        return createResult(call, output);
      } catch (err) {
        return createResult(call, err instanceof Error ? err.message : String(err), true);
      }
    },
  };
}
