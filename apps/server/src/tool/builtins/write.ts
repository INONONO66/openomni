import { mkdirSync, realpathSync } from "node:fs";
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
    let parent = dirname(resolved);
    while (parent !== root) {
      try {
        const realParent = realpathSync(parent);
        const realRoot = realpathSync(root);
        if (realParent !== realRoot && !realParent.startsWith(`${realRoot}/`)) {
          throw new Error(`Path escapes workspace root via symlink: ${root}`);
        }
        break;
      } catch (parentErr) {
        if ((parentErr as NodeJS.ErrnoException).code !== "ENOENT") throw parentErr;
        const nextParent = dirname(parent);
        if (nextParent === parent) break;
        parent = nextParent;
      }
    }
  }

  return resolved;
}

const WRITE_PROMPT = `Write content to a file inside the workspace.
Creates parent directories as needed and overwrites any existing file at the path.
The path must stay within the workspace root; symlink escapes are rejected.`;

export function createWriteTool(workspaceRoot: string) {
  return defineTool<{ path: string; content: string }>({
    name: "write",
    description: "Write a file within the workspace",
    prompt: WRITE_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File contents" },
      },
      required: ["path", "content"],
    },
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    source: "system",
    async execute(call) {
      try {
        const targetPath = getNonEmptyString(call.input, "path");
        const content = getNonEmptyString(call.input, "content");
        const resolved = resolveContainedPath(workspaceRoot, targetPath);

        mkdirSync(dirname(resolved), { recursive: true });
        await Bun.write(resolved, content);

        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `Wrote ${content.length} bytes to ${resolved}`,
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
