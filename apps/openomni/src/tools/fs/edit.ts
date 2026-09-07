import { defineTool, ToolRefused } from "@openomni/agent";
import { z } from "zod";
import { fileOperation, filesystem, text, type FilePorts } from "./endpoint";

export function createEditTool(ports: FilePorts) {
  return defineTool({
    name: "edit",
    description:
      "Replace exactly one literal UTF-8 occurrence in a local or machineId:/absolute/path file. Refuses absent or ambiguous matches. Read/write composition is not atomic against external writers.",
    category: "mutation",
    sequential: true,
    input: z
      .object({ path: z.string().min(1), oldText: z.string().min(1), newText: z.string() })
      .strict(),
    output: z.object({ bytesWritten: z.number().int().nonnegative() }),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("edit", async () => {
        ctx.signal.throwIfAborted();
        const endpoint = filesystem(args.path, ports);
        const content = text(await endpoint.read());
        const index = content.indexOf(args.oldText);
        if (index < 0 || content.indexOf(args.oldText, index + 1) >= 0)
          throw new ToolRefused("edit", "oldText must match exactly once");
        ctx.signal.throwIfAborted();
        return {
          bytesWritten: await endpoint.write(
            Buffer.from(
              content.slice(0, index) + args.newText + content.slice(index + args.oldText.length),
            ),
          ),
        };
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
