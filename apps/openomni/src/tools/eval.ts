import { CodemodeError, type createCodemode } from "@openomni/codemode";
import { defineTool, ToolRefused } from "@openomni/agent";
import { Machine } from "@openomni/protocol";
import { z } from "zod";

type Cell = ReturnType<typeof createCodemode>["cell"];

/**
 * A cell left in the background is `timed_out` at this deadline: the model
 * has `stop`, and an interpreter must not outlive its session's interest.
 */
const CELL_CEILING_MS = 10 * 60_000;

const cellId = z.string().min(1).describe("The cell_id a run answered with while still running.");
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
        .describe(
          "Seconds to wait for the cell. A cell still running is answered as running with its cell_id and keeps going in the background.",
        ),
    })
    .strict(),
  z.object({ op: z.literal("peek"), cell_id: cellId }).strict(),
  z.object({ op: z.literal("stop"), cell_id: cellId }).strict(),
]);
type Operation = z.output<typeof operation>;
// Like monitor and provision: an object root keeps the op union out of the wire root.
const Input = z.object({ operation }).strict();

function outputOf(output: Machine.CellOutput): string {
  const streams = [output.stdout, output.stderr].filter((stream) => stream !== "");
  return streams.length === 0 ? "" : `\n${streams.join("\n")}`;
}

function describe(state: Machine.CellState): string {
  if (state.status === "completed") return state.value ?? state.output.stdout;
  if (state.status === "raised") return `the cell raised: ${state.error}${outputOf(state.output)}`;
  if (state.status === "running")
    return `cell ${state.cellId} is still running; peek or stop it by cell_id${outputOf(state.output)}`;
  if (state.status === "timed_out")
    return `the cell was stopped at the ${CELL_CEILING_MS / 60_000} minute ceiling${outputOf(state.output)}`;
  if (state.status === "cancelled") return `the cell was stopped${outputOf(state.output)}`;
  return state.reason;
}

async function executeOperation(
  cell: Cell,
  operation: Operation,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<Machine.CellState> {
  try {
    if (operation.op === "run")
      return await cell.run(operation.code, sessionId, {
        timeoutMs: CELL_CEILING_MS,
        waitMs: operation.timeout * 1000,
        signal,
      });
    if (operation.op === "peek") return await cell.peek(operation.cell_id, sessionId);
    return await cell.stop(operation.cell_id, sessionId);
  } catch (error) {
    if (error instanceof CodemodeError && error.data.reason === "unknown_cell_id")
      throw new ToolRefused("eval", "no such cell_id in this session");
    throw error;
  }
}

/** The catalog is static: without a composed codemode the tool exists and refuses. */
export function createEvalTool(cell: Cell | undefined) {
  return defineTool({
    name: "eval",
    category: "execution",
    description:
      "Run Python in this session's persistent cell: state survives between calls; machine handles, parallel, completion, and tool.<name>() proxies are in scope. operation.op=run starts code and waits up to timeout seconds; peek reads a running cell's output so far; stop interrupts it. stop and the 10 minute ceiling discard the interpreter's state.",
    input: Input,
    output: Machine.CellState,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: ({ operation }, ctx) => {
      if (cell === undefined) throw new ToolRefused("eval", "codemode is not composed");
      return executeOperation(cell, operation, ctx.sessionId, ctx.signal);
    },
    render: (_args, value) => describe(value),
  });
}
