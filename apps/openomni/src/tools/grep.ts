import { defineTool, ToolRefused } from "@openomni/agent";
import { z } from "zod";
import { fileOperation, text, walk, type FilePorts } from "./core/filesystem";

const Input = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).default("."),
    glob: z.string().min(1).optional(),
    ignoreCase: z.boolean().default(false),
    literal: z.boolean().default(false),
    context: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const Match = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  text: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
});

function compile(args: z.output<typeof Input>): RegExp {
  const source = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern;
  try {
    return new RegExp(source, args.ignoreCase ? "i" : "");
  } catch (error) {
    throw new ToolRefused("grep", `invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createGrepTool(ports: FilePorts) {
  return defineTool({
    name: "grep",
    description:
      "Search UTF-8 file content with a regular expression (literal=true for plain text) at a local path or machineId:/absolute/path. Directories recurse in name order without following symlinks; glob filters file names; context adds surrounding lines; binary files refuse.",
    category: "query",
    input: Input,
    output: z.object({ matches: z.array(Match), truncated: z.boolean() }),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("grep", async () => {
        const pattern = compile(args);
        const names = args.glob === undefined ? undefined : new Bun.Glob(args.glob);
        const matches: z.output<typeof Match>[] = [];
        let truncated = false;
        await walk(args.path, ports, ctx.signal, async (path, endpoint, kind) => {
          if (kind !== "file") return true;
          if (names !== undefined && !names.match(path.slice(path.lastIndexOf("/") + 1)))
            return true;
          const lines = text(await endpoint.read()).split("\n");
          for (const [index, line] of lines.entries()) {
            if (!pattern.test(line)) continue;
            if (args.limit !== undefined && matches.length >= args.limit) {
              truncated = true;
              return false;
            }
            matches.push({
              path,
              line: index + 1,
              text: line,
              before: lines.slice(Math.max(0, index - args.context), index),
              after: lines.slice(index + 1, index + 1 + args.context),
            });
          }
          return true;
        });
        return { matches, truncated };
      }),
    render: (_args, value) => renderMatches(value),
  });
}

/** `path:line:text` per match, context lines marked with `-`, truncation stated last. */
function renderMatches(value: { matches: z.output<typeof Match>[]; truncated: boolean }): string {
  const lines: string[] = [];
  for (const match of value.matches) {
    let line = match.line - match.before.length;
    for (const before of match.before) lines.push(`${match.path}-${line++}-${before}`);
    lines.push(`${match.path}:${match.line}:${match.text}`);
    line = match.line + 1;
    for (const after of match.after) lines.push(`${match.path}-${line++}-${after}`);
  }
  if (value.truncated) lines.push("[truncated: limit reached]");
  return lines.join("\n");
}
