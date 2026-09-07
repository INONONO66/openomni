import { defineTool, ToolRefused } from "@openomni/agent";
import { z } from "zod";
import { fileOperation, filesystem, type FilePorts } from "./endpoint";

export function createWriteTool(ports: FilePorts) {
  return defineTool({
    name: "write",
    description:
      "Create or overwrite one local or machineId:/absolute/path file. Parent directories must exist.",
    category: "mutation",
    sequential: true,
    input: z
      .object({
        path: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      })
      .strict(),
    output: z.object({ bytesWritten: z.number().int().nonnegative() }),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("write", async () => {
        ctx.signal.throwIfAborted();
        const data = Buffer.from(args.content, args.encoding);
        if (args.encoding === "base64" && data.toString("base64") !== args.content)
          throw new ToolRefused("write", "expected canonical base64");
        return { bytesWritten: await filesystem(args.path, ports).write(data) };
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
