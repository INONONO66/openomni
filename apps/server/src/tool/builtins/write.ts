import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool } from "../define";
import { requireString } from "../shared/input";
import { fromError, successResult } from "../shared/result";
import { resolveContainedPathForCreate } from "../shared/workspace-path";
import { WRITE_PROMPT } from "./write-prompt";

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
        const targetPath = requireString(call.input, "path");
        const content = requireString(call.input, "content");
        const resolved = resolveContainedPathForCreate(workspaceRoot, targetPath);

        mkdirSync(dirname(resolved), { recursive: true });
        const bytes = await Bun.write(resolved, content);

        return successResult(call, `Wrote ${bytes} bytes to ${resolved}`);
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}
