import { defineTool, ToolRefused } from "@openomni/agent";
import { z } from "zod";
import { childPath, fileOperation, filesystem, text, type FilePorts } from "./endpoint";

export function createSearchTool(ports: FilePorts) {
  return defineTool({
    name: "search",
    description:
      "Search UTF-8 file content for literal text at a local path or machineId:/absolute/path. Directories recurse in name order without following symlinks; binary files refuse. Returns matching lines, not regex or glob matches.",
    category: "query",
    input: z.object({ path: z.string().min(1), pattern: z.string().min(1) }).strict(),
    output: z.array(
      z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }),
    ),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("search", async () => {
        const matches: { path: string; line: number; text: string }[] = [];
        const visit = async (path: string): Promise<void> => {
          ctx.signal.throwIfAborted();
          const endpoint = filesystem(path, ports);
          const kind = await endpoint.kind();
          if (kind === "dir") {
            for (const entry of await endpoint.list()) {
              if (entry.kind === "file" || entry.kind === "dir")
                await visit(childPath(endpoint.locus, entry.name));
            }
          } else if (kind === "file") {
            const lines = text(await endpoint.read()).split("\n");
            for (const [index, line] of lines.entries())
              if (line.includes(args.pattern)) matches.push({ path, line: index + 1, text: line });
          } else throw new ToolRefused("search", "expected a regular file or directory");
        };
        await visit(args.path);
        return matches;
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
