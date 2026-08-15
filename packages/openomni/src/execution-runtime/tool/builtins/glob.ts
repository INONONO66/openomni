import { statSync } from "node:fs";
import type { Tool } from "@openomni/protocol";
import {
  defineTool,
  optionalString,
  requireString,
  errorResult,
  fromError,
  successResult,
} from "../define.js";
import { resolveContainedPath } from "../../filesystem/workspace-path.js";
const MAX_RESULTS = 100;

async function executeGlob(call: Tool.Call, workspaceRoot: string): Promise<Tool.Result> {
  try {
    const pattern = requireString(call.input, "pattern");
    const searchDir = resolveContainedPath(
      workspaceRoot,
      optionalString(call.input, "path") ?? ".",
    );

    if (!statSync(searchDir).isDirectory()) {
      return errorResult(call, `Search path must be a directory: ${searchDir}`);
    }

    const glob = new Bun.Glob(pattern);
    const matches = await Array.fromAsync(glob.scan({ cwd: searchDir, absolute: true }));
    const ranked = matches.flatMap((filePath) => {
      try {
        return [{ filePath, mtime: statSync(filePath).mtimeMs }];
      } catch {
        return [];
      }
    });

    ranked.sort(
      (left, right) => right.mtime - left.mtime || left.filePath.localeCompare(right.filePath),
    );

    return successResult(
      call,
      JSON.stringify(
        ranked.slice(0, MAX_RESULTS).map((entry) => entry.filePath),
        null,
        2,
      ),
    );
  } catch (err) {
    return fromError(call, err);
  }
}

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

// merged from glob-prompt.ts (#453 hygiene: sub-30-LOC single-importer)
const GLOB_PROMPT = `Match files against a glob pattern (e.g. '**/*.ts') inside the workspace.
Results are sorted newest-first by mtime and capped at 100 entries.
Paths must stay within the workspace root; symlink escapes are rejected.`;
