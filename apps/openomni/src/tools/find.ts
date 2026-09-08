import { defineTool } from "@openomni/agent";
import { z } from "zod";
import { fileOperation, walker, type FilePorts } from "./core/filesystem";
import { parseLocus } from "./locus";

export function createFindTool(ports: FilePorts) {
  const walk = walker(ports);
  return defineTool({
    name: "find",
    description:
      "Find files and directories whose path relative to the search root matches a glob (e.g. **/*.ts). path defaults to the current directory; machineId:/absolute/path searches a machine. Symlinks are not followed.",
    category: "query",
    input: z
      .object({
        pattern: z.string().min(1),
        path: z.string().min(1).default("."),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    output: z.object({ paths: z.array(z.string()), truncated: z.boolean() }),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("find", async () => {
        const glob = new Bun.Glob(args.pattern);
        const machine = parseLocus(args.path).kind === "machine";
        const paths: string[] = [];
        let truncated = false;
        await walk(args.path, ctx.signal, async (path) => {
          const relative = relativeTo(args.path, path, machine);
          if (relative === "" || !glob.match(relative)) return true;
          truncated = !admit(paths, path, args.limit);
          return !truncated;
        });
        return { paths, truncated };
      }),
    render: (_args, value) => renderPaths(value),
  });
}

/** One path per line, truncation stated last. */
function renderPaths(value: { readonly paths: readonly string[]; readonly truncated: boolean }) {
  return [...value.paths, ...(value.truncated ? ["[truncated: limit reached]"] : [])].join("\n");
}

/** Record a hit unless the limit is already spent; false tells the walk to stop. */
function admit(paths: string[], path: string, limit: number | undefined): boolean {
  if (paths.length >= (limit ?? Number.POSITIVE_INFINITY)) return false;
  paths.push(path);
  return true;
}

/** The walked path minus the search root, so globs read like `**\/*.ts` from the root. */
function relativeTo(root: string, path: string, machine: boolean): string {
  const base = machine ? root : root.replace(/^\.\//, "");
  const target = machine ? path : path.replace(/^\.\//, "");
  if (target === base) return "";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}
