import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineTool } from "../define";

type InputRecord = Record<string, unknown>;

function getNonEmptyString(input: InputRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid input: ${key} must be a non-empty string`);
  }
  return value;
}

function getOptionalPositiveInteger(input: InputRecord, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid input: ${key} must be a positive integer`);
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

async function readFile(resolved: string, offset?: number, limit?: number): Promise<string> {
  const text = await Bun.file(resolved).text();
  const lines = text.split(/\r?\n/);
  const start = Math.max((offset ?? 1) - 1, 0);
  const end = limit ? start + limit : lines.length;

  return lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
}

function readDirectory(resolved: string): string {
  return readdirSync(resolved)
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => {
      const entryPath = resolve(resolved, entry);
      const stats = statSync(entryPath);
      return stats.isDirectory() ? `${entry}/` : entry;
    })
    .join("\n");
}

const READ_PROMPT = `Read file contents or list a directory inside the workspace.
Files return line-prefixed text (1-indexed); directories return sorted entries with trailing slash for subdirectories.
Use offset and limit for paginated reads of large files. Paths must stay within the workspace root.`;

export function createReadTool(workspaceRoot: string) {
  return defineTool<{ path: string; offset?: number; limit?: number }>({
    name: "read",
    description: "Read a file or directory within the workspace",
    prompt: READ_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path" },
        offset: { type: "integer", minimum: 1, description: "1-indexed line offset" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    riskTier: 0,
    async execute(call) {
      try {
        const targetPath = getNonEmptyString(call.input, "path");
        const offset = getOptionalPositiveInteger(call.input, "offset");
        const limit = getOptionalPositiveInteger(call.input, "limit");
        const resolved = resolveContainedPath(workspaceRoot, targetPath);

        const stats = statSync(resolved);
        const output = stats.isDirectory()
          ? readDirectory(resolved)
          : await readFile(resolved, offset, limit);

        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output,
        };
      } catch (err) {
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}
