import { statSync } from "node:fs";
import type { Tool } from "@openomni/protocol";
import { defineTool } from "../define";
import { optionalBoolean, optionalString, requireString } from "../shared/input";
import { errorResult, fromError, successResult } from "../shared/result";
import { resolveContainedPath } from "../shared/workspace-path";
import type { NativeTool } from "../types";
import { GREP_PROMPT } from "./grep-prompt";

type MatchResult = { file: string; line: number; text: string };

const MAX_MATCHES = 100;

function normalizeIncludePattern(include?: string): string | undefined {
  if (!include) return undefined;
  return include.includes("/") || include.startsWith("**/") ? include : `**/${include}`;
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
    "-e",
    pattern,
    "--",
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
): Promise<Tool.Result> {
  const binary = Bun.which("grep");
  if (!binary) return errorResult(call, "Neither rg nor grep is available");

  const matches: MatchResult[] = [];
  const files = await collectFiles(rootPath, include);
  const command = [binary, "-rnH", "-E", ...(ignoreCase ? ["-i"] : []), "-e", pattern, "--"];

  for (const filePath of files) {
    if (matches.length >= MAX_MATCHES) break;
    const proc = Bun.spawn([...command, filePath], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode > 1) {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      return errorResult(call, output || `grep exited with code ${exitCode}`);
    }

    for (const line of stdout.split(/\r?\n/)) {
      if (!line || matches.length >= MAX_MATCHES) continue;
      const parsed = line.match(/^(.*?):(\d+):(.*)$/);
      if (!parsed) continue;
      matches.push({ file: parsed[1], line: Number(parsed[2]), text: parsed[3] });
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
    async execute(call) {
      try {
        const pattern = requireString(call.input, "pattern");
        const targetPath = optionalString(call.input, "path") ?? ".";
        const include = optionalString(call.input, "include");
        const ignoreCase = optionalBoolean(call.input, "ignoreCase");
        const resolved = resolveContainedPath(workspaceRoot, targetPath);

        return await searchWithRg(call, pattern, resolved, include, ignoreCase);
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}
