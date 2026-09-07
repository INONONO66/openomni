import { defineTool } from "@openomni/agent";
import { z } from "zod";
import { fileOperation, walk, type FilePorts } from "./core/filesystem";

export function createFindTool(ports: FilePorts) {
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
        const paths: string[] = [];
        let truncated = false;
        await walk(args.path, ports, ctx.signal, async (path, endpoint) => {
          const relative = relativeTo(args.path, path, endpoint.locus.kind === "machine");
          if (relative !== "" && glob.match(relative)) {
            if (args.limit !== undefined && paths.length >= args.limit) {
              truncated = true;
              return false;
            }
            paths.push(path);
          }
          return true;
        });
        return { paths, truncated };
      }),
    render: (_args, value) =>
      [...value.paths, ...(value.truncated ? ["[truncated: limit reached]"] : [])].join("\n"),
  });
}

/** The walked path minus the search root, so globs read like `**\/*.ts` from the root. */
function relativeTo(root: string, path: string, machine: boolean): string {
  const base = machine ? root : root.replace(/^\.\//, "");
  const target = machine ? path : path.replace(/^\.\//, "");
  if (target === base) return "";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}
