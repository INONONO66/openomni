import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
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

function getString(input: InputRecord, key: string): string {
  const value = input[key];
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

function replaceOnce(
  text: string,
  search: string,
  replacement: string,
): { text: string; count: number } {
  const index = text.indexOf(search);
  if (index < 0) return { text, count: 0 };
  return {
    text: `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`,
    count: 1,
  };
}

const EDIT_PROMPT = `Replace an exact substring in a file within the workspace.
oldString must already exist in the file and must differ from newString.
Default behavior replaces the first occurrence; set replaceAll=true to replace every match.`;

export function createEditTool(workspaceRoot: string) {
  return defineTool<{ path: string; oldString: string; newString: string; replaceAll?: boolean }>({
    name: "edit",
    description: "Replace exact text in a file",
    prompt: EDIT_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        oldString: { type: "string", description: "Text to replace" },
        newString: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace all occurrences" },
      },
      required: ["path", "oldString", "newString"],
    },
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    source: "system",
    async execute(call) {
      try {
        const filePath = getString(call.input, "path");
        const oldString = getString(call.input, "oldString");
        const newString = getString(call.input, "newString");
        const replaceAll = getOptionalBoolean(call.input, "replaceAll") ?? false;

        if (oldString === newString) {
          throw new Error("Invalid input: oldString and newString must be different");
        }

        const resolved = resolveContainedPath(workspaceRoot, filePath);
        const file = Bun.file(resolved);

        if (!(await file.exists())) {
          throw new Error(`Path does not exist: ${filePath}`);
        }

        const original = await file.text();
        if (!original.includes(oldString)) {
          throw new Error(`oldString not found in file: ${filePath}`);
        }

        const { text, count } = replaceAll
          ? {
              text: original.split(oldString).join(newString),
              count: original.split(oldString).length - 1,
            }
          : replaceOnce(original, oldString, newString);

        await Bun.write(resolved, text);

        return createResult(
          call,
          `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${resolved}`,
        );
      } catch (err) {
        return createResult(call, err instanceof Error ? err.message : String(err), true);
      }
    },
  });
}
