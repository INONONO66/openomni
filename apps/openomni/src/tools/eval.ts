import type { createCodemode } from "@openomni/codemode";
import { defineTool, ToolRefused } from "@openomni/agent";
import { Machine } from "@openomni/protocol";
import { z } from "zod";

type Cell = ReturnType<typeof createCodemode>["cell"];

const operation = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("run"),
      code: z.string().min(1),
      timeout: z
        .number()
        .int()
        .positive()
        .default(15)
        .describe("Seconds before the cell is stopped."),
    })
    .strict(),
]);
// Like monitor and provision: an object root keeps the op union out of the wire root.
const Input = z.object({ operation }).strict();

function describe(result: Machine.CellResult, timeout: number): string {
  if (result.status === "completed") return result.value ?? result.output.stdout;
  if (result.status === "raised") return `the cell raised: ${result.error}${stderrOf(result)}`;
  if (result.status === "timed_out") return `the cell did not finish within ${timeout}s`;
  if (result.status === "cancelled") return "the cell was cancelled";
  return result.reason;
}

function stderrOf(result: { readonly output: { readonly stderr: string } }): string {
  return result.output.stderr === "" ? "" : `\n${result.output.stderr}`;
}

/** The catalog is static: without a composed codemode the tool exists and refuses. */
export function createEvalTool(cell: Cell | undefined) {
  return defineTool({
    name: "eval",
    category: "execution",
    description:
      "Run Python in this session's persistent cell: state survives between calls; machine handles, parallel, completion, and tool.<name>() proxies are in scope. operation.op=run.",
    input: Input,
    output: Machine.CellResult,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: ({ operation }, ctx) => {
      if (cell === undefined) throw new ToolRefused("eval", "codemode is not composed");
      const timeoutMs = operation.timeout * 1000;
      return cell.run(operation.code, ctx.sessionId, { timeoutMs, signal: ctx.signal });
    },
    render: (args, value) => describe(value, args.operation.timeout),
  });
}
