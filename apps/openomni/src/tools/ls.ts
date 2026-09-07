import { defineTool } from "@openomni/agent";
import { z } from "zod";
import { fileOperation, filesystem, type FilePorts } from "./core/filesystem";

export function createLsTool(ports: FilePorts) {
  return defineTool({
    name: "ls",
    description:
      "List immediate directory entries at a local path or machineId:/absolute/path, without following symlinks. limit caps the entries returned.",
    category: "query",
    input: z
      .object({ path: z.string().min(1), limit: z.number().int().positive().optional() })
      .strict(),
    output: z.object({
      entries: z.array(
        z.object({ name: z.string(), kind: z.enum(["file", "dir", "symlink", "other"]) }),
      ),
      truncated: z.boolean(),
    }),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("ls", async () => {
        ctx.signal.throwIfAborted();
        const entries = await filesystem(args.path, ports).list();
        const truncated = args.limit !== undefined && entries.length > args.limit;
        return { entries: truncated ? entries.slice(0, args.limit) : entries, truncated };
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
