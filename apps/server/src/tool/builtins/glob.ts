import { dirname, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import type { Tool } from "@openomni/protocol";
import { defineTool } from "../define";

type InputRecord = Record<string, unknown>;

function createResult(call: Tool.Call, output: string, isError?: boolean): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output,
    ...(isError ? { isError } : {}),
  };
}

function getNonEmptyString(input: InputRecord, key: string): string {
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

function resolveContainedPath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, inputPath);

  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Path must stay within workspace root: ${root}`);
  }

  try {
    const realResolved = realpathSync(resolved);
    const realRoot = realpathSync(root);
    if (realResolved !== realRoot && !realResolved.startsWith(`${realRoot}/`)) {
      throw new Error(`Path escapes workspace root via symlink: ${root}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const realParent = realpathSync(dirname(resolved));
    const realRoot = realpathSync(root);
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}/`)) {
      throw new Error(`Path escapes workspace root via symlink: ${root}`);
    }
  }

  const stats = statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`Search path must be a directory: ${inputPath}`);
  }

  return resolved;
}

async function executeGlob(call: Tool.Call, workspaceRoot: string): Promise<Tool.Result> {
  try {
    const pattern = getNonEmptyString(call.input, "pattern");
    const searchDir = resolveContainedPath(
      workspaceRoot,
      getOptionalString(call.input, "path") ?? ".",
    );
    const glob = new Bun.Glob(pattern);
    const matches = await Array.fromAsync(glob.scan({ cwd: searchDir, absolute: true }));
    const ranked = matches.map((filePath) => ({ filePath, mtime: statSync(filePath).mtimeMs }));

    ranked.sort(
      (left, right) => right.mtime - left.mtime || left.filePath.localeCompare(right.filePath),
    );

    return createResult(
      call,
      JSON.stringify(
        ranked.slice(0, 100).map((entry) => entry.filePath),
        null,
        2,
      ),
    );
  } catch (err) {
    return createResult(call, err instanceof Error ? err.message : String(err), true);
  }
}

const GLOB_PROMPT = `Match files against a glob pattern (e.g. '**/*.ts') inside the workspace.
Results are sorted newest-first by mtime and capped at 100 entries.
Paths must stay within the workspace root; symlink escapes are rejected.`;

export function createGlobTool(workspaceRoot: string) {
  return defineTool({
    name: "glob",
    description: "Match files by glob pattern",
    prompt: GLOB_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Search directory" },
      },
      required: ["pattern"],
    },
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    riskTier: 0,
    async execute(call) {
      return executeGlob(call, workspaceRoot);
    },
  });
}
