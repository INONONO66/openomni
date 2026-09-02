import type { ChatAgentConfig } from "@openomni/agent";
import { placementGatedExecutor } from "@openomni/agent";
import { Placement } from "@openomni/placement";
import { Machine } from "@openomni/protocol";
import { z } from "zod";
import { defineTool } from "../core/define";
import type { DelegationOrigin } from "../../delegation/admission";
import type { CatalogEntry } from "../core/dispatch";
import { createDispatcher, HOST_TARGET } from "../core/dispatch";
import type { CellRegistry } from "../cell-registry";

/** What running a cell needs, without knowing how the host is composed. */
export interface CellPorts {
  readonly registry: CellRegistry;
  runCell(
    machineId: Machine.MachineId,
    request: Machine.CellRequest,
  ): Promise<
    | Machine.CellResult
    | {
        readonly status: "refused";
        readonly reason: "machine_not_attached" | "kernel_not_available" | "isolation_unavailable";
      }
  >;
  /**
   * The whole catalog `origin` holds when the cell runs on `machineId` —
   * machine-placed tools included. The brain-only fold that subtracts machine
   * tools lives at the enforcement point: see {@link cellDoor}.
   *
   * `machineId` is not decoration. A cell's authority is its machine's, so a
   * surface that addresses machines BY NAME (the fs namespace) must be bound
   * to the one the cell actually runs on before the catalog is built — the
   * composition root does that binding, which is why the target is a
   * parameter here rather than a fact the cell could state about itself.
   */
  toolsFor(origin: DelegationOrigin, machineId: Machine.MachineId): readonly CatalogEntry[];
  newCellId(): string;
}

/**
 * What a running cell may call back for: the same catalog, folded against the
 * brain alone.
 *
 * Two things follow from that single target, neither of them restated as a
 * rule here. Machine-placed tools drop out — a cell already runs on a
 * machine, so reaching back to the brain to reach another machine is the
 * round trip code mode exists to remove, and a machine tool added later is
 * excluded by the same fold. And the gate is load-bearing rather than
 * belt-and-braces: a cell's `tool.<name>()` never passes through the agent
 * loop, so this door is the only one watching it.
 */
export function cellDoor(
  entries: readonly CatalogEntry[],
): NonNullable<ChatAgentConfig["toolExecutor"]> {
  const dispatcher = createDispatcher(entries);
  return placementGatedExecutor(
    Placement.resolveTools(dispatcher.specs, [HOST_TARGET]),
    dispatcher.execute,
  );
}

const Input = z
  .object({
    machineId: z.string().min(1).describe("Which attached machine runs the code."),
    code: z
      .string()
      .min(1)
      .describe(
        "Python source. Call host tools inside it as tool.<name>(...) — that is the point: many calls, one round trip.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe("How long the cell may run before it is stopped."),
  })
  .strict();

export const RUN_CODE_TOOL_NAME = "run_code";

function describe(result: Awaited<ReturnType<CellPorts["runCell"]>>, timeoutMs: number): string {
  switch (result.status) {
    case "completed":
      return result.value ?? result.output.stdout;
    case "raised":
      return `the cell raised: ${result.error}${result.output.stderr === "" ? "" : `\n${result.output.stderr}`}`;
    case "timed_out":
      return `the cell did not finish within ${timeoutMs}ms — what it had done is unknown, not undone`;
    case "refused":
      switch (result.reason) {
        case "machine_not_attached":
          return "that machine is not attached right now";
        case "kernel_not_available":
          return "that machine has no code kernel to run this";
        case "isolation_unavailable":
          return "run_code refused: process isolation is unavailable on that machine";
      }
  }
}

function executeRunCode(ports: CellPorts, origin: DelegationOrigin) {
  return async ({ machineId, code, timeoutMs }: z.output<typeof Input>): Promise<Awaited<ReturnType<CellPorts["runCell"]>>> => {

    const cellId = ports.newCellId();
    ports.registry.bind(cellId, cellDoor(ports.toolsFor(origin, machineId)));
    try {
      // The session is the tenant: the daemon runs each tenant's cells on its
      // own interpreter, so state — and anything a cell leaves running — can
      // never cross into another session's process.
      return await ports.runCell(machineId, { cellId, code, timeoutMs, tenant: origin.sessionId });
    } finally {
      ports.registry.release(cellId);
    }
  };
}

export const runCodeTool = defineTool({
  name: RUN_CODE_TOOL_NAME, category: "execution",
  description: "Run Python on an attached machine; state persists across cells in _scope, so do a whole step in one cell. Inside it, tool.<name>(...) bridges to the tools you hold here, parallel(thunks) runs independent calls concurrently, llm(prompt) asks a budget-capped sub-model, and write_artifact/read_artifact move large text by id.",
  input: Input, output: z.custom<Awaited<ReturnType<CellPorts["runCell"]>>>((value) => typeof value === "object" && value !== null), safe: false,
  execution: { kind: "machine", capability: "kernel.py" },
  requires: [
    Machine.WellKnownCapability.pythonKernel,
    Machine.WellKnownCapability.sandboxProcess,
  ],
  visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
  bind: (ports, origin) => ports.cells === undefined ? undefined : executeRunCode(ports.cells, origin),
  render: (args, value) => describe(value, args.timeoutMs),
});
