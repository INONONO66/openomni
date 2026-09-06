import type { createCodemode } from "@openomni/codemode";
import { defineTool } from "@openomni/agent";
import { Machine } from "@openomni/protocol";
import { z } from "zod";

type Cell = ReturnType<typeof createCodemode>["cell"];

function describe(result: Machine.CellResult, timeoutMs: number): string {
  switch (result.status) {
    case "completed": return result.value ?? result.output.stdout;
    case "raised": return `the cell raised: ${result.error}${result.output.stderr === "" ? "" : `\n${result.output.stderr}`}`;
    case "timed_out": return `the cell did not finish within ${timeoutMs}ms`;
    case "cancelled": return "the cell was cancelled";
    case "refused": return result.reason;
  }
}

export function createRunCodeTool(cell: Cell) {
  return defineTool({
    name: "run_code",
    category: "execution",
    description: "Run Python with persistent tenant state, machine handles, parallel, llm, and host tool proxies.",
    input: z.object({ code: z.string().min(1), timeoutMs: z.number().int().positive() }).strict(),
    output: Machine.CellResult,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: ({ code, timeoutMs }, ctx) => cell.run(code, ctx.sessionId, { timeoutMs, signal: ctx.signal }),
    render: (args, value) => describe(value, args.timeoutMs),
  });
}
