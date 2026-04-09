import { resolve, sep } from "node:path";
import type { Tool } from "@openomni/protocol";
import type { NativeTool } from "../../types";

type InputRecord = Record<string, unknown>;

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

function getOptionalBoolean(input: InputRecord, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid input: ${key} must be a boolean`);
  }
  return value;
}

function resolveWorkingDirectory(workspaceRoot: string, requestedWorkdir?: string): string {
  const root = resolve(workspaceRoot);
  const cwd = requestedWorkdir ? resolve(root, requestedWorkdir) : root;

  if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) {
    throw new Error(`Working directory must stay within workspace root: ${root}`);
  }

  return cwd;
}

async function runGit(
  call: Tool.Call,
  args: string[],
  workspaceRoot: string,
  workdir?: string,
): Promise<Tool.Result> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: resolveWorkingDirectory(workspaceRoot, workdir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = [stdout, stderr]
      .filter((chunk) => chunk.length > 0)
      .join("\n")
      .trim();

    if (exitCode !== 0) {
      return createResult(call, output || `git exited with code ${exitCode}`, true);
    }

    return createResult(call, output);
  } catch (err) {
    return createResult(call, err instanceof Error ? err.message : String(err), true);
  }
}

export function createGitTools(workspaceRoot: string): NativeTool[] {
  return [
    {
      spec: {
        name: "git.status",
        description: "Show git working tree status",
        inputSchema: {
          type: "object",
          properties: {
            workdir: { type: "string", description: "Repository working directory" },
          },
        },
        safe: true,
      },
      prompt: "Use this to inspect the repository working tree state.",
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      source: "system",
      execute(call) {
        return runGit(
          call,
          ["status", "--short", "--branch"],
          workspaceRoot,
          getOptionalString(call.input, "workdir"),
        );
      },
    },
    {
      spec: {
        name: "git.diff",
        description: "Show git diff",
        inputSchema: {
          type: "object",
          properties: {
            workdir: { type: "string", description: "Repository working directory" },
            staged: { type: "boolean", description: "Show staged diff" },
          },
        },
        safe: true,
      },
      prompt: "Use this to inspect unstaged or staged repository changes.",
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      source: "system",
      execute(call) {
        const staged = getOptionalBoolean(call.input, "staged") ?? false;
        const args = staged ? ["diff", "--cached"] : ["diff"];
        return runGit(call, args, workspaceRoot, getOptionalString(call.input, "workdir"));
      },
    },
    {
      spec: {
        name: "git.commit",
        description: "Create a git commit",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Commit message" },
            workdir: { type: "string", description: "Repository working directory" },
          },
          required: ["message"],
        },
      },
      prompt: "Use this to create a commit in the current repository.",
      riskTier: 1,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "system",
      execute(call) {
        const message = getString(call.input, "message");
        return runGit(
          call,
          ["commit", "-m", message],
          workspaceRoot,
          getOptionalString(call.input, "workdir"),
        );
      },
    },
    {
      spec: {
        name: "git.branch",
        description: "List or create git branches",
        inputSchema: {
          type: "object",
          properties: {
            workdir: { type: "string", description: "Repository working directory" },
            create: { type: "string", description: "Branch name to create" },
          },
        },
        safe: true,
      },
      prompt: "Use this to list branches or create a new local branch.",
      riskTier: 0,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "system",
      execute(call) {
        const branchName = getOptionalString(call.input, "create");
        const args = branchName ? ["branch", branchName] : ["branch", "--list"];
        return runGit(call, args, workspaceRoot, getOptionalString(call.input, "workdir"));
      },
    },
    {
      spec: {
        name: "git.push",
        description: "Push git branch to remote",
        inputSchema: {
          type: "object",
          properties: {
            workdir: { type: "string", description: "Repository working directory" },
            remote: { type: "string", description: "Remote name" },
            branch: { type: "string", description: "Branch name" },
          },
        },
      },
      prompt: "Use this to push repository changes to a remote.",
      riskTier: 2,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "system",
      execute(call) {
        const remote = getOptionalString(call.input, "remote") ?? "origin";
        const branch = getOptionalString(call.input, "branch");
        const args = ["push", remote, ...(branch ? [branch] : [])];
        return runGit(call, args, workspaceRoot, getOptionalString(call.input, "workdir"));
      },
    },
  ];
}
