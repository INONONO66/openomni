import { defineTool } from "../define.js";
import { optionalBoolean, optionalString, requireString } from "../shared/input.js";
import { errorResult, fromError, successResult } from "../shared/result.js";
import { resolveContainedPath } from "../../filesystem/workspace-path.js";
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

function replaceMany(
  text: string,
  search: string,
  replacement: string,
): { text: string; count: number } {
  const parts = text.split(search);
  return { text: parts.join(replacement), count: parts.length - 1 };
}

export function createEditTool(workspaceRoot: string) {
  return defineTool<{
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    expectedFileHash?: string;
  }>({
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
        expectedFileHash: {
          type: "string",
          description: "Expected SHA-256 hash of the current file",
        },
      },
      required: ["path", "oldString", "newString"],
    },
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    source: "system",
    async execute(call) {
      try {
        const filePath = requireString(call.input, "path");
        const oldString = requireString(call.input, "oldString");
        const newString = requireString(call.input, "newString");
        const replaceAll = optionalBoolean(call.input, "replaceAll") ?? false;
        const expectedFileHash = optionalString(call.input, "expectedFileHash");

        if (oldString === newString) {
          return errorResult(call, "Invalid input: oldString and newString must be different");
        }

        const resolved = resolveContainedPath(workspaceRoot, filePath);
        const file = Bun.file(resolved);

        if (!(await file.exists())) {
          return errorResult(call, `Path does not exist: ${filePath}`);
        }

        if (expectedFileHash !== undefined && !isSha256Hex(expectedFileHash)) {
          return errorResult(
            call,
            "Invalid input: expectedFileHash must be a lowercase SHA-256 hex digest",
          );
        }

        const original = await file.text();
        if (expectedFileHash !== undefined) {
          const actualFileHash = await sha256Hex(original);
          if (actualFileHash !== expectedFileHash) {
            return errorResult(
              call,
              `File hash mismatch for ${filePath}: expected ${expectedFileHash}, got ${actualFileHash}`,
            );
          }
        }

        if (!original.includes(oldString)) {
          return errorResult(call, `oldString not found in file: ${filePath}`);
        }

        const { text, count } = replaceAll
          ? replaceMany(original, oldString, newString)
          : replaceOnce(original, oldString, newString);

        await Bun.write(resolved, text);

        return successResult(
          call,
          `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${resolved}`,
        );
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

// merged from edit-prompt.ts (#453 hygiene: sub-30-LOC single-importer)
export const EDIT_PROMPT = `Replace an exact substring in a file within the workspace.
oldString must already exist in the file and must differ from newString.
Default behavior replaces the first occurrence; set replaceAll=true to replace every match.
Set expectedFileHash to the current file SHA-256 hash to reject stale edits.`;
