import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createWorkspaceIdentity, type WorkspaceIdentity } from "../../workspace-identity.js";
import { defineTool } from "../define.js";
import { requireString } from "../shared/input.js";
import { fromError, successResult } from "../shared/result.js";
import { resolveContainedPathForCreate } from "../../filesystem/workspace-path.js";
export function createWriteTool(workspace: WorkspaceIdentity | string) {
  const identity = typeof workspace === "string" ? createWorkspaceIdentity(workspace) : workspace;
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
        const targetPath = requireString(call.input, "path");
        const content = requireString(call.input, "content");
        const resolved = resolveContainedPathForCreate(identity, targetPath);

        mkdirSync(dirname(resolved), { recursive: true });
        const revalidated = resolveContainedPathForCreate(identity, targetPath);
        if (revalidated !== resolved) throw new Error("workspace target changed before write");
        const bytes = await Bun.write(revalidated, content);

        return successResult(call, `Wrote ${bytes} bytes to ${resolved}`);
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

// merged from write-prompt.ts (#453 hygiene: sub-30-LOC single-importer)
export const WRITE_PROMPT = `Write content to a file inside the workspace.
Creates parent directories as needed and overwrites any existing file at the path.
The path must stay within the workspace root; symlink escapes are rejected.`;
