import { dirname, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { defineTool } from "../define";
import type { NativeTool } from "../types";
import type { Tool } from "@openomni/protocol";

type InputRecord = Record<string, unknown>;
type MatchResult = { file: string; line: number; text: string };

function createResult(call: Tool.Call, output: string, isError?: boolean): Tool.Result {
  return { id: crypto.randomUUID(), toolCallId: call.id, output, ...(isError ? { isError } : {}) };
}

function mustString(v: unknown, key: string): string {
  if (typeof v !== "string" || v.length === 0)
    throw new Error(`Invalid input: ${key} must be a non-empty string`);
  return v;
}
const getString = (i: InputRecord, k: string) => mustString(i[k], k);
const getOptionalString = (i: InputRecord, k: string) =>
  i[k] === undefined ? undefined : mustString(i[k], k);
function getOptionalBoolean(i: InputRecord, k: string): boolean | undefined {
  const v = i[k];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new Error(`Invalid input: ${k} must be a boolean`);
  return v;
}

const GREP_PROMPT = `Search file contents for a regex pattern across the workspace.
Use include (glob) to narrow the files searched and ignoreCase for case-insensitive matches.
Returns up to 100 entries as {file, line, text}. Paths must stay within the workspace root.`;

function normalizeIncludePattern(include?: string): string | undefined {
  if (!include) return undefined;
  return include.includes("/") || include.startsWith("**/") ? include : `**/${include}`;
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

async function collectFiles(rootPath: string, include?: string): Promise<string[]> {
  if (statSync(rootPath).isFile()) return [rootPath];
  const glob = new Bun.Glob(normalizeIncludePattern(include) ?? "**/*");
  return Array.fromAsync(glob.scan({ cwd: rootPath, absolute: true, onlyFiles: true, dot: true }));
}

async function searchWithRg(
  call: Tool.Call,
  pattern: string,
  rootPath: string,
  include?: string,
  ignoreCase?: boolean,
): Promise<Tool.Result> {
  const binary = Bun.which("rg");
  if (!binary) return searchWithGrep(call, pattern, rootPath, include, ignoreCase);

  const args = [
    "--json",
    "-n",
    "--no-heading",
    "--color",
    "never",
    ...(ignoreCase ? ["-i"] : []),
    ...(include ? ["-g", include] : []),
    pattern,
    rootPath,
  ];
  const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode > 1) {
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return createResult(call, output || `rg exited with code ${exitCode}`, true);
  }

  const matches: MatchResult[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || matches.length >= 100) continue;
    let event: {
      type?: string;
      data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const file = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const text = event.data?.lines?.text?.replace(/\r?\n$/, "");
    if (!file || typeof lineNumber !== "number" || text === undefined) continue;
    matches.push({ file, line: lineNumber, text });
  }

  return createResult(call, JSON.stringify(matches.slice(0, 100), null, 2));
}

async function searchWithGrep(
  call: Tool.Call,
  pattern: string,
  rootPath: string,
  include?: string,
  ignoreCase?: boolean,
): Promise<Tool.Result> {
  const binary = Bun.which("grep");
  if (!binary) {
    return createResult(call, "Neither rg nor grep is available", true);
  }

  const matches: MatchResult[] = [];
  const files = await collectFiles(rootPath, include);
  const command = [binary, "-rnH", "-E", ...(ignoreCase ? ["-i"] : []), pattern];

  for (const filePath of files) {
    if (matches.length >= 100) break;
    const proc = Bun.spawn([...command, filePath], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode > 1) {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      return createResult(call, output || `grep exited with code ${exitCode}`, true);
    }

    for (const line of stdout.split(/\r?\n/)) {
      if (!line || matches.length >= 100) continue;
      const parsed = line.match(/^(.*?):(\d+):(.*)$/);
      if (!parsed) continue;
      matches.push({ file: parsed[1], line: Number(parsed[2]), text: parsed[3] });
    }
  }

  return createResult(call, JSON.stringify(matches.slice(0, 100), null, 2));
}

export function createGrepTool(workspaceRoot: string): NativeTool {
  return defineTool({
    name: "grep.search",
    description: "Search file contents with a regex",
    prompt: GREP_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression pattern" },
        path: { type: "string", description: "File or directory path" },
        include: { type: "string", description: "Glob filter for files to search" },
        ignoreCase: { type: "boolean", description: "Match case-insensitively" },
      },
      required: ["pattern"],
    },
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    async execute(call) {
      try {
        const pattern = getString(call.input, "pattern");
        const targetPath = getOptionalString(call.input, "path") ?? ".";
        const include = getOptionalString(call.input, "include");
        const ignoreCase = getOptionalBoolean(call.input, "ignoreCase");
        const resolved = resolveContainedPath(workspaceRoot, targetPath);

        return await searchWithRg(call, pattern, resolved, include, ignoreCase);
      } catch (err) {
        return createResult(call, err instanceof Error ? err.message : String(err), true);
      }
    },
  });
}
