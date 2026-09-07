import { defineTool } from "@openomni/agent";
import { z } from "zod";
import { fileOperation, filesystem, type FilePorts } from "./endpoint";

export function createListTool(ports: FilePorts) {
  return defineTool({
    name: "list",
    description:
      "List immediate directory entries at a local path or machineId:/absolute/path, without following symlinks.",
    category: "query",
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.array(
      z.object({ name: z.string(), kind: z.enum(["file", "dir", "symlink", "other"]) }),
    ),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("list", () => {
        ctx.signal.throwIfAborted();
        return filesystem(args.path, ports).list();
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
