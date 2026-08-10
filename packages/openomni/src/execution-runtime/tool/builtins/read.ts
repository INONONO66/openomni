import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  defineTool,
  optionalPositiveInteger,
  requireString,
  fromError,
  successResult,
} from "../define.js";
import { resolveContainedPath } from "../../filesystem/workspace-path.js";
async function readFile(path: string, offset?: number, limit?: number): Promise<string> {
  const text = await Bun.file(path).text();
  const lines = text.split(/\r?\n/);
  const start = Math.max((offset ?? 1) - 1, 0);
  const end = limit ? start + limit : lines.length;

  return lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
}

function readDirectory(path: string): string {
  return readdirSync(path)
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => {
      const entryPath = resolve(path, entry);
      const stats = statSync(entryPath);
      return stats.isDirectory() ? `${entry}/` : entry;
    })
    .join("\n");
}

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
        const targetPath = requireString(call.input, "path");
        const offset = optionalPositiveInteger(call.input, "offset");
        const limit = optionalPositiveInteger(call.input, "limit");
        const resolved = resolveContainedPath(workspaceRoot, targetPath);

        const stats = statSync(resolved);
        const output = stats.isDirectory()
          ? readDirectory(resolved)
          : await readFile(resolved, offset, limit);

        return successResult(call, output);
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

// merged from read-prompt.ts (#453 hygiene: sub-30-LOC single-importer)
export const READ_PROMPT = `Read file contents or list a directory inside the workspace.
Files return line-prefixed text (1-indexed); directories return sorted entries with trailing slash for subdirectories.
Use offset and limit for paginated reads of large files. Paths must stay within the workspace root.`;
