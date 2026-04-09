import { dirname, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
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

  return resolved;
}

async function scanMatches(rootPath: string, pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const matches = await Array.fromAsync(
    glob.scan({ cwd: rootPath, absolute: true, onlyFiles: true, dot: true }),
  );

  matches.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return matches.slice(0, 100);
}

export function createGlobTool(workspaceRoot: string): NativeTool {
  return {
    spec: {
      name: "glob",
      description: "Find files matching a glob pattern",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
          pattern: { type: "string", description: "Glob pattern" },
        },
        required: ["path", "pattern"],
      },
      safe: true,
    },
    prompt: "Use this to locate files by glob pattern within the workspace.",
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    async execute(call) {
      try {
        const path = getString(call.input, "path");
        const pattern = getString(call.input, "pattern");
        const resolved = resolveContainedPath(workspaceRoot, path);
        let stats;
        try {
          stats = statSync(resolved);
        } catch {
          throw new Error(`Path does not exist: ${path}`);
        }

        if (!stats.isDirectory()) {
          throw new Error(`Path is not a directory: ${path}`);
        }

        const entries = await scanMatches(resolved, pattern);
        return createResult(call, JSON.stringify(entries, null, 2));
      } catch (err) {
        return createResult(call, err instanceof Error ? err.message : String(err), true);
      }
    },
  };
}
