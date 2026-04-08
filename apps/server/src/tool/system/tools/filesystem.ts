import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

function getNonEmptyString(input: InputRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid input: ${key} must be a non-empty string`);
  }
  return value;
}

function getString(input: InputRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`Invalid input: ${key} must be a string`);
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

function getEncoding(input: InputRecord): "utf8" | "base64" {
  const value = input.encoding;
  if (value === undefined) return "utf8";
  if (value === "utf8" || value === "base64") return value;
  throw new Error('Invalid input: encoding must be "utf8" or "base64"');
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
    // target doesn't exist yet (e.g. write) — pre-symlink check is sufficient
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return resolved;
}

async function searchFiles(rootPath: string, recursive: boolean): Promise<string[]> {
  const resolvedRoot = resolve(rootPath);
  const rootStat = statSync(resolvedRoot);

  if (rootStat.isFile()) {
    return [resolvedRoot];
  }

  const globPattern = recursive ? "**/*" : "*";
  const glob = new Bun.Glob(globPattern);
  return Array.fromAsync(
    glob.scan({ cwd: resolvedRoot, absolute: true, onlyFiles: true, dot: true }),
  );
}

async function executeRead(call: Tool.Call, workspaceRoot: string): Promise<Tool.Result> {
  try {
    const filePath = getNonEmptyString(call.input, "path");
    const encoding = getEncoding(call.input);
    const resolved = resolveContainedPath(workspaceRoot, filePath);
    const file = Bun.file(resolved);

    if (!(await file.exists())) {
      throw new Error(`Path does not exist: ${filePath}`);
    }

    const output =
      encoding === "base64"
        ? Buffer.from(await file.arrayBuffer()).toString("base64")
        : await file.text();

    return createResult(call, output);
  } catch (err) {
    return createResult(call, err instanceof Error ? err.message : String(err), true);
  }
}

async function executeWrite(call: Tool.Call, workspaceRoot: string): Promise<Tool.Result> {
  try {
    const filePath = getNonEmptyString(call.input, "path");
    const content = getString(call.input, "content");
    const resolved = resolveContainedPath(workspaceRoot, filePath);

    mkdirSync(dirname(resolved), { recursive: true });
    await Bun.write(resolved, content);

    return createResult(call, `Wrote ${content.length} bytes to ${resolved}`);
  } catch (err) {
    return createResult(call, err instanceof Error ? err.message : String(err), true);
  }
}

async function executeList(call: Tool.Call, workspaceRoot: string): Promise<Tool.Result> {
  try {
    const targetPath = getNonEmptyString(call.input, "path");
    const resolved = resolveContainedPath(workspaceRoot, targetPath);
    const entries = readdirSync(resolved).map((entry) => {
      const entryPath = resolve(resolved, entry);
      const stats = statSync(entryPath);
      return {
        name: entry,
        type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        size: stats.size,
      };
    });

    return createResult(call, JSON.stringify(entries, null, 2));
  } catch (err) {
    return createResult(call, err instanceof Error ? err.message : String(err), true);
  }
}

async function executeSearch(call: Tool.Call, workspaceRoot: string): Promise<Tool.Result> {
  try {
    const targetPath = getNonEmptyString(call.input, "path");
    const pattern = getNonEmptyString(call.input, "pattern");
    const recursive = getOptionalBoolean(call.input, "recursive") ?? true;
    const resolved = resolveContainedPath(workspaceRoot, targetPath);
    const regex = new RegExp(pattern, "gm");
    const filePaths = await searchFiles(resolved, recursive);
    const matches: Array<{ path: string; matches: string[] }> = [];

    for (const filePath of filePaths) {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        continue;
      }

      const text = await file.text();
      regex.lastIndex = 0;
      const found = Array.from(text.matchAll(regex), (match) => match[0]).filter(Boolean);
      if (found.length > 0) {
        matches.push({ path: filePath, matches: found });
      }
    }

    return createResult(call, JSON.stringify(matches, null, 2));
  } catch (err) {
    return createResult(call, err instanceof Error ? err.message : String(err), true);
  }
}

export function createFilesystemTools(workspaceRoot: string): NativeTool[] {
  return [
    {
      spec: {
        name: "fs.read",
        description: "Read a file from disk",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            encoding: {
              type: "string",
              enum: ["utf8", "base64"],
              description: "Response encoding",
            },
          },
          required: ["path"],
        },
        safe: true,
      },
      riskTier: 0,
      execute: (call) => executeRead(call, workspaceRoot),
    },
    {
      spec: {
        name: "fs.write",
        description: "Write a file to disk",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File contents" },
          },
          required: ["path", "content"],
        },
      },
      riskTier: 1,
      execute: (call) => executeWrite(call, workspaceRoot),
    },
    {
      spec: {
        name: "fs.list",
        description: "List directory contents",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path" },
          },
          required: ["path"],
        },
        safe: true,
      },
      riskTier: 0,
      execute: (call) => executeList(call, workspaceRoot),
    },
    {
      spec: {
        name: "fs.search",
        description: "Search file contents with a regex",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File or directory path" },
            pattern: { type: "string", description: "Regular expression pattern" },
            recursive: { type: "boolean", description: "Recurse into subdirectories" },
          },
          required: ["path", "pattern"],
        },
        safe: true,
      },
      riskTier: 0,
      execute: (call) => executeSearch(call, workspaceRoot),
    },
  ];
}
