import { resolve } from "node:path";
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

function resolveWorkingDirectory(requestedWorkdir?: string): string {
  return requestedWorkdir ? resolve(requestedWorkdir) : process.cwd();
}

async function runGit(call: Tool.Call, args: string[], workdir?: string): Promise<Tool.Result> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: resolveWorkingDirectory(workdir),
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

const gitToolDefinitions: Array<{
  name: string;
  description: string;
  riskTier: 0 | 1 | 2;
  inputSchema: Record<string, unknown>;
  execute(call: Tool.Call): Promise<Tool.Result>;
}> = [
  {
    name: "git.status",
    description: "Show git working tree status",
    riskTier: 0,
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Repository working directory" },
      },
    },
    execute(call) {
      return runGit(
        call,
        ["status", "--short", "--branch"],
        getOptionalString(call.input, "workdir"),
      );
    },
  },
  {
    name: "git.diff",
    description: "Show git diff",
    riskTier: 0,
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Repository working directory" },
        staged: { type: "boolean", description: "Show staged diff" },
      },
    },
    execute(call) {
      const staged = getOptionalBoolean(call.input, "staged") ?? false;
      const args = staged ? ["diff", "--cached"] : ["diff"];
      return runGit(call, args, getOptionalString(call.input, "workdir"));
    },
  },
  {
    name: "git.commit",
    description: "Create a git commit",
    riskTier: 1,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" },
        workdir: { type: "string", description: "Repository working directory" },
      },
      required: ["message"],
    },
    execute(call) {
      const message = getString(call.input, "message");
      return runGit(call, ["commit", "-m", message], getOptionalString(call.input, "workdir"));
    },
  },
  {
    name: "git.branch",
    description: "List or create git branches",
    riskTier: 0,
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Repository working directory" },
        create: { type: "string", description: "Branch name to create" },
      },
    },
    async execute(call) {
      const branchName = getOptionalString(call.input, "create");
      const args = branchName ? ["branch", branchName] : ["branch", "--list"];
      return runGit(call, args, getOptionalString(call.input, "workdir"));
    },
  },
  {
    name: "git.push",
    description: "Push git branch to remote",
    riskTier: 2,
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Repository working directory" },
        remote: { type: "string", description: "Remote name" },
        branch: { type: "string", description: "Branch name" },
      },
    },
    execute(call) {
      const remote = getOptionalString(call.input, "remote") ?? "origin";
      const branch = getOptionalString(call.input, "branch");
      const args = ["push", remote, ...(branch ? [branch] : [])];
      return runGit(call, args, getOptionalString(call.input, "workdir"));
    },
  },
];

export const gitTools: NativeTool[] = gitToolDefinitions.map((definition) => ({
  spec: {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    safe: definition.riskTier === 0,
  },
  riskTier: definition.riskTier,
  execute: definition.execute,
}));
