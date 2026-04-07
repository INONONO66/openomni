import { mkdirSync, readdirSync, statSync } from "node:fs";
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

async function executeRead(call: Tool.Call): Promise<Tool.Result> {
  try {
    const filePath = getNonEmptyString(call.input, "path");
    const encoding = getEncoding(call.input);
    const file = Bun.file(resolve(filePath));

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

async function executeWrite(call: Tool.Call): Promise<Tool.Result> {
  try {
    const filePath = resolve(getNonEmptyString(call.input, "path"));
    const content = getString(call.input, "content");

    mkdirSync(dirname(filePath), { recursive: true });
    await Bun.write(filePath, content);

    return createResult(call, `Wrote ${content.length} bytes to ${filePath}`);
  } catch (err) {
    return createResult(call, err instanceof Error ? err.message : String(err), true);
  }
}

async function executeList(call: Tool.Call): Promise<Tool.Result> {
  try {
    const targetPath = resolve(getNonEmptyString(call.input, "path"));
    const entries = readdirSync(targetPath).map((entry) => {
      const entryPath = resolve(targetPath, entry);
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

async function executeSearch(call: Tool.Call): Promise<Tool.Result> {
  try {
    const targetPath = getNonEmptyString(call.input, "path");
    const pattern = getNonEmptyString(call.input, "pattern");
    const recursive = getOptionalBoolean(call.input, "recursive") ?? true;
    const regex = new RegExp(pattern, "gm");
    const filePaths = await searchFiles(targetPath, recursive);
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

export const filesystemTools: NativeTool[] = [
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
    execute: executeRead,
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
    execute: executeWrite,
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
    execute: executeList,
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
    execute: executeSearch,
  },
];
