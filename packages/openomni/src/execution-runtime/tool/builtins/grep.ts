import { statSync } from "node:fs";
import type { Tool } from "@openomni/protocol";
import {
  defineTool,
  optionalBoolean,
  optionalString,
  requireString,
  errorResult,
  fromError,
  successResult,
} from "../define.js";
import { resolveContainedPath } from "../../filesystem/workspace-path.js";
import type { NativeTool, ToolExecutionContext } from "../types.js";
type MatchResult = { file: string; line: number; text: string };

const MAX_MATCHES = 100;

type PipeProcess = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  kill(): void;
};

function abortError(): Error {
  const error = new Error("Tool execution aborted");
  error.name = "AbortError";
  return error;
}

async function waitForProcess(
  proc: PipeProcess,
  signal?: AbortSignal,
): Promise<readonly [string, string, number | null]> {
  if (signal?.aborted) {
    proc.kill();
    throw abortError();
  }

  const abortProcess = () => proc.kill();
  signal?.addEventListener("abort", abortProcess, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (signal?.aborted) {
      throw abortError();
    }

    return [stdout, stderr, exitCode] as const;
  } finally {
    signal?.removeEventListener("abort", abortProcess);
  }
}

function normalizeIncludePattern(include?: string): string | undefined {
  if (!include) return undefined;
  return include.includes("/") || include.startsWith("**/") ? include : `**/${include}`;
}

async function collectFiles(
  rootPath: string,
  include?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) throw abortError();
  if (statSync(rootPath).isFile()) return [rootPath];
  const glob = new Bun.Glob(normalizeIncludePattern(include) ?? "**/*");
  const files: string[] = [];
  for await (const filePath of glob.scan({
    cwd: rootPath,
    absolute: true,
    onlyFiles: true,
    dot: true,
  })) {
    if (signal?.aborted) throw abortError();
    files.push(filePath);
  }
  return files;
}

async function searchWithRg(
  call: Tool.Call,
  pattern: string,
  rootPath: string,
  include?: string,
  ignoreCase?: boolean,
  signal?: AbortSignal,
): Promise<Tool.Result> {
  const binary = Bun.which("rg");
  if (!binary) return searchWithGrep(call, pattern, rootPath, include, ignoreCase, signal);

  const args = [
    "--json",
    "-n",
    "--no-heading",
    "--color",
    "never",
    ...(ignoreCase ? ["-i"] : []),
    ...(include ? ["-g", include] : []),
    "-e",
    pattern,
    "--",
    rootPath,
  ];
  const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await waitForProcess(proc, signal);

  if (exitCode !== null && exitCode > 1) {
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return errorResult(call, output || `rg exited with code ${exitCode}`);
  }

  const matches: MatchResult[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || matches.length >= MAX_MATCHES) continue;
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

  return successResult(call, JSON.stringify(matches.slice(0, MAX_MATCHES), null, 2));
}

async function searchWithGrep(
  call: Tool.Call,
  pattern: string,
  rootPath: string,
  include?: string,
  ignoreCase?: boolean,
  signal?: AbortSignal,
): Promise<Tool.Result> {
  const binary = Bun.which("grep");
  if (!binary) return errorResult(call, "Neither rg nor grep is available");

  const matches: MatchResult[] = [];
  const files = await collectFiles(rootPath, include, signal);
  const command = [binary, "-rnH", "-E", ...(ignoreCase ? ["-i"] : []), "-e", pattern, "--"];

  for (const filePath of files) {
    if (signal?.aborted) throw abortError();
    if (matches.length >= MAX_MATCHES) break;
    const proc = Bun.spawn([...command, filePath], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await waitForProcess(proc, signal);

    if (exitCode !== null && exitCode > 1) {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      return errorResult(call, output || `grep exited with code ${exitCode}`);
    }

    for (const line of stdout.split(/\r?\n/)) {
      if (!line || matches.length >= MAX_MATCHES) continue;
      const parsed = line.match(/^(.*?):(\d+):(.*)$/);
      if (!parsed) continue;
      const [, file, lineNumber, text] = parsed;
      if (file == null || lineNumber == null || text == null) continue;
      matches.push({ file, line: Number(lineNumber), text });
    }
  }

  return successResult(call, JSON.stringify(matches.slice(0, MAX_MATCHES), null, 2));
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
    async execute(call, context?: ToolExecutionContext) {
      try {
        const pattern = requireString(call.input, "pattern");
        const targetPath = optionalString(call.input, "path") ?? ".";
        const include = optionalString(call.input, "include");
        const ignoreCase = optionalBoolean(call.input, "ignoreCase");
        const resolved = resolveContainedPath(workspaceRoot, targetPath);

        return await searchWithRg(call, pattern, resolved, include, ignoreCase, context?.signal);
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

// merged from grep-prompt.ts (#453 hygiene: sub-30-LOC single-importer)
const GREP_PROMPT = `Search file contents for a regex pattern across the workspace.
Use include (glob) to narrow the files searched and ignoreCase for case-insensitive matches.
Returns up to 100 entries as {file, line, text}. Paths must stay within the workspace root.`;
