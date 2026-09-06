import { defineTool } from "@openomni/agent";
import { z } from "zod";
import { fileOperation, filesystem, text, type FilePorts } from "./endpoint";

export function createReadTool(ports: FilePorts) {
  return defineTool({
    name: "read",
    description:
      "Read a local path or machineId:/absolute/path. UTF-8 text by default; base64 preserves binary bytes.",
    category: "query",
    input: z
      .object({ path: z.string().min(1), encoding: z.enum(["utf8", "base64"]).default("utf8") })
      .strict(),
    output: z.object({ content: z.string(), bytes: z.number().int().nonnegative() }),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("read", async () => {
        ctx.signal.throwIfAborted();
        const bytes = await filesystem(args.path, ports).read();
        return {
          content: args.encoding === "base64" ? bytes.toString("base64") : text(bytes),
          bytes: bytes.length,
        };
      }),
    render: (_args, value) => value.content,
  });
}
