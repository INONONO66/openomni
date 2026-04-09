import { resolve } from "node:path";
import type { Tool } from "@openomni/protocol";
import { defineTool } from "../define";
import type { NativeTool } from "../types";
import { BASH_PROMPT } from "./bash-prompt";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "pwd",
  "which",
  "head",
  "tail",
  "wc",
  "echo",
  "find",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "describe",
  "tag",
  "ls-files",
]);

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /^rm\s+-rf?(\s|$)/,
  /^git\s+push(\s|$)/,
  /^git\s+reset\s+--hard(\s|$)/,
  /^git\s+clean\s+-f/,
  /^mv(\s|$)/,
  /^chmod(\s|$)/,
];

export function isReadOnlyCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const head = tokens[0];
  if (!head) return false;
  if (head === "git") {
    const sub = tokens[1];
    return sub !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(sub);
  }
  return READ_ONLY_COMMANDS.has(head);
}

export function isDestructiveCommand(command: string): boolean {
  const trimmed = command.trim();
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

interface BashInput {
  command: string;
  workdir?: string;
  timeoutMs?: number;
}

function getCommand(input: Record<string, unknown>): string {
  const value = input.command;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid input: command must be a non-empty string");
  }
  return value;
}

function getOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid input: ${key} must be a non-empty string`);
  }
  return value;
}

function getTimeout(input: Record<string, unknown>): number {
  const value = input.timeoutMs;
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid input: timeoutMs must be a positive number");
  }
  return Math.min(value, MAX_TIMEOUT_MS);
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

function createResult(call: Tool.Call, output: string, isError?: boolean): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output,
    ...(isError ? { isError } : {}),
  };
}

function readCommandFromMeta(input: unknown): string {
  if (input && typeof input === "object" && "command" in input) {
    const value = (input as { command?: unknown }).command;
    if (typeof value === "string") return value;
  }
  return "";
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
        const command = getCommand(call.input);
        const cwd = resolveWorkingDirectory(
          workspaceRoot,
          getOptionalString(call.input, "workdir"),
        );
        const timeoutMs = getTimeout(call.input);

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
  });
}
