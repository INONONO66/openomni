import type { ChatAgentConfig } from "@openomni/agent";
import type { AnyToolDefinition, Machine } from "@openomni/protocol";
import { z } from "zod";
import { createDispatcher, defineTool } from "@openomni/agent";
import type { CellRegistry } from "../cell-registry";

/** What running a cell needs, without knowing how the host is composed. */
export interface CellPorts {
  readonly registry: CellRegistry;
  readonly defaultMachineId: Machine.MachineId;
  runCell(
    machineId: Machine.MachineId,
    request: Machine.CellRequest,
  ): Promise<
    | Machine.CellResult
    | {
        readonly status: "refused";
        readonly reason: "machine_not_attached" | "kernel_not_available";
      }
  >;
  /** Session catalogs are registered once by createTools and reused by every cell call. */
  bindTools(sessionId: string, tools: readonly AnyToolDefinition[]): void;
  tools(sessionId: string): readonly AnyToolDefinition[];
  newCellId(): string;
}

function cellDoor(
  definitions: readonly AnyToolDefinition[],
  sessionId: string,
  cellId: string,
): NonNullable<ChatAgentConfig["toolExecutor"]> {
  const cellTools = definitions.filter(
    (tool) => tool.name !== RUN_CODE_TOOL_NAME && tool.visibility.cell.length > 0,
  );
  const dispatcher = createDispatcher(cellTools);
  return async (call, context) =>
    dispatcher.executeCell(call, {
      sessionId,
      turnId: cellId,
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    }) as Promise<Awaited<ReturnType<NonNullable<ChatAgentConfig["toolExecutor"]>>>>;
}

const Input = z
  .object({
    code: z.string().min(1).describe("Python source. Call host tools as tool.<name>(...)."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe("How long the cell may run before it is stopped."),
  })
  .strict();

const RUN_CODE_TOOL_NAME = "run_code";

function describe(result: Awaited<ReturnType<CellPorts["runCell"]>>, timeoutMs: number): string {
  switch (result.status) {
    case "completed":
      return result.value ?? result.output.stdout;
    case "raised":
      return `the cell raised: ${result.error}${result.output.stderr === "" ? "" : `\n${result.output.stderr}`}`;
    case "timed_out":
      return `the cell did not finish within ${timeoutMs}ms — what it had done is unknown, not undone`;
    case "refused":
      return result.reason === "machine_not_attached"
        ? "the default kernel host is not attached right now"
        : "the default host has no code kernel to run this";
  }
}

export function createRunCodeTool(ports: CellPorts) {
  return defineTool({
    name: RUN_CODE_TOOL_NAME,
    category: "execution",
    description:
      "Run Python on the local default kernel host. State persists across cells in _scope; host tools are available through tool.<name>(...).",
    input: Input,
    output: z.custom<Awaited<ReturnType<CellPorts["runCell"]>>>(
      (value) => typeof value === "object" && value !== null,
    ),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: async ({ code, timeoutMs }, ctx) => {
      const cellId = ports.newCellId();
      ports.registry.bind(
        cellId,
        cellDoor(ports.tools(ctx.sessionId), ctx.sessionId, cellId),
        ctx,
      );
      try {
        return await ports.runCell(ports.defaultMachineId, {
          cellId,
          code,
          timeoutMs,
          tenant: ctx.sessionId,
        });
      } finally {
        ports.registry.release(cellId);
      }
    },
    render: (args, value) => describe(value, args.timeoutMs),
  });
}
