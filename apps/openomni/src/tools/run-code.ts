import type { ChatAgentConfig } from "@openomni/agent";
import { placementGatedExecutor } from "@openomni/agent";
import { Placement } from "@openomni/placement";
import { Machine, type Tool } from "@openomni/protocol";
import { z } from "zod";
import type { DelegationOrigin } from "../delegation/admission";
import type { CatalogEntry } from "./dispatch";
import { createDispatcher, HOST_TARGET } from "./dispatch";
import type { CellRegistry } from "./cell-registry";

/** What running a cell needs, without knowing how the host is composed. */
export interface CellPorts {
  readonly registry: CellRegistry;
  runCell(
    machineId: Machine.MachineId,
    request: Machine.CellRequest,
  ): Promise<
    | Machine.CellResult
    | { readonly status: "refused"; readonly reason: "machine_not_attached" | "kernel_not_available" }
  >;
  /**
   * The whole catalog `origin` holds — machine-placed tools included — which
   * is then folded against the brain alone. Handing over everything and
   * letting placement subtract is what keeps machine tools out of a cell
   * structurally: a cell already runs on a machine, so reaching back to the
   * brain to reach another machine is the round trip code mode exists to
   * remove. A machine tool added later is excluded by the same fold, with
   * nobody having to remember this rule.
   */
  toolsFor(origin: DelegationOrigin): readonly CatalogEntry[];
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
    timeoutMs: z.number().int().positive().describe("How long the cell may run before it is stopped."),
  })
  .strict();

export const RUN_CODE_TOOL_NAME = "run_code";

/**
 * Hand-written for the same reason the delegate tool's is: zod 3 ships no
 * JSON Schema conversion. The zod object above stays the runtime gate, and a
 * test pins the two together so they cannot drift apart silently.
 */
const INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["machineId", "code", "timeoutMs"],
  properties: {
    machineId: { type: "string", minLength: 1, description: "Which attached machine runs the code." },
    code: {
      type: "string",
      minLength: 1,
      description:
        "Python source. Call host tools inside it as tool.<name>(...) — that is the point: many calls, one round trip.",
    },
    timeoutMs: {
      type: "integer",
      exclusiveMinimum: 0,
      description: "How long the cell may run before it is stopped.",
    },
  },
};

export function runCodeToolSpec(): Tool.Spec {
  return {
    name: RUN_CODE_TOOL_NAME,
    description:
      "Run Python on an attached machine. Inside the cell, tool.<name>(...) reaches the same tools you hold here — use it to make many calls in one turn instead of one call per turn.",
    inputSchema: INPUT_JSON_SCHEMA,
    safe: false,
    placement: "machine",
    requires: [Machine.WellKnownCapability.pythonKernel],
  };
}

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
        ? "that machine is not attached right now"
        : "that machine has no code kernel to run this";
  }
}

export function runCodeToolExecutor(ports: CellPorts, origin: DelegationOrigin) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = Input.safeParse(rawInput);
    if (!parsed.success) {
      return `run_code refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const { machineId, code, timeoutMs } = parsed.data;

    const cellId = ports.newCellId();
    ports.registry.bind(cellId, cellDoor(ports.toolsFor(origin)));
    try {
      return describe(await ports.runCell(machineId, { cellId, code, timeoutMs }), timeoutMs);
    } finally {
      ports.registry.release(cellId);
    }
  };
}
