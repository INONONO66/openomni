import { describe, expect, it } from "bun:test";
import { placementGatedExecutor } from "@openomni/agent";
import { Placement } from "@openomni/placement";
import type { Machine, Tool } from "@openomni/protocol";
import type { CatalogEntry } from "../src/tools/catalog";
import { catalogEntries, cellDoor, createDispatcher, HOST_TARGET } from "../src/tools/catalog";
import { createCellRegistry } from "../src/tools/cell-registry";
import type { CellPorts } from "../src/tools/run-code";
import { RUN_CODE_TOOL_NAME, runCodeToolExecutor } from "../src/tools/run-code";

const RESIDENT = { role: "resident", depth: 0 } as const;

function machineTarget(capabilities: string[]): Placement.ToolTarget {
  return { kind: "machine", id: "alpha", capabilities };
}

/** A kernel stand-in: records what it was asked, answers immediately. */
function recordingDelegation() {
  const seen: Array<{ text: string; origin: unknown }> = [];
  return {
    seen,
    kernel: {
      delegate: async (request: { payload: { text: string } }, origin: unknown) => {
        seen.push({ text: request.payload.text, origin });
        return { settled: { status: "completed", output: `did: ${request.payload.text}` } };
      },
    } as never,
  };
}

function cellPorts(options: {
  delegation: never;
  runCell: (machineId: string, request: Machine.CellRequest) => Promise<Machine.CellResult>;
  registry?: ReturnType<typeof createCellRegistry>;
}) {
  const registry = options.registry ?? createCellRegistry();
  let n = 0;
  // Self-referential exactly as the composition root is: the cell's catalog is
  // the full one, which includes the tool that dispatches cells.
  const ports: CellPorts = {
    registry,
    runCell: options.runCell,
    toolsFor: (origin) => catalogEntries({ delegation: options.delegation, cells: ports }, origin),
    newCellId: () => `cell-${++n}`,
  };
  return { registry, ports };
}

describe("tool catalog placement", () => {
  it("hands the loop the whole catalog and lets it fold", () => {
    const { kernel } = recordingDelegation();
    const { ports } = cellPorts({ delegation: kernel, runCell: async () => ({ status: "timed_out", cellId: "x" }) });
    const catalog = createDispatcher(catalogEntries({ delegation: kernel, cells: ports }, RESIDENT));

    // Unfiltered on purpose: the agent loop folds this against the turn's
    // targets and gates the calls, so a second fold here would be a copy.
    expect(catalog.specs.map((s: Tool.Spec) => s.name)).toEqual(["delegate", RUN_CODE_TOOL_NAME]);
  });

  it("serves the machine tool only for a machine holding the capability it requires", async () => {
    const { kernel } = recordingDelegation();
    const { ports } = cellPorts({ delegation: kernel, runCell: async () => ({ status: "timed_out", cellId: "x" }) });
    const entries = catalogEntries({ delegation: kernel, cells: ports }, RESIDENT);
    const call = { id: "1", tool: RUN_CODE_TOOL_NAME, input: { machineId: "alpha", code: "x", timeoutMs: 250 } };

    const gate = (targets: Placement.ToolTarget[]) =>
      placementGatedExecutor(Placement.resolveTools(createDispatcher(entries).specs, targets), createDispatcher(entries).execute);

    const withoutKernel = await gate([HOST_TARGET, machineTarget(["fs.read"])])(call);
    const withKernel = await gate([HOST_TARGET, machineTarget(["fs.read", "kernel.py"])])(call);

    expect(withoutKernel.isError).toBe(true);
    expect(withoutKernel.output).toContain("kernel.py");
    expect(withKernel.isError).toBeUndefined();
  });

  it("refuses a name it never had, whoever asks", async () => {
    const { kernel } = recordingDelegation();
    const catalog = createDispatcher(catalogEntries({ delegation: kernel }, RESIDENT));

    const unheard = await catalog.execute({ id: "2", tool: "rm_rf", input: {} });

    expect(unheard.isError).toBe(true);
    expect(unheard.output).toContain("unknown tool");
  });
});

describe("the cell door", () => {
  it("serves a host tool called from inside a cell, on the dispatcher's authority", async () => {
    const { kernel, seen } = recordingDelegation();
    const registry = createCellRegistry();
    const calls: Machine.ToolCallResult[] = [];
    const { ports } = cellPorts({
      delegation: kernel,
      registry,
      runCell: async (_machineId, request) => {
        // Stand in for the daemon: the cell reaches back mid-flight.
        calls.push(
          await registry.callTool({
            cellId: request.cellId,
            name: "delegate",
            arguments: { instruction: "count the files", mode: "ask", scope: "inline", timeoutMs: 1000 },
          }),
        );
        return { status: "completed", cellId: request.cellId, output: { stdout: "ok", stderr: "" } };
      },
    });

    const answer = await runCodeToolExecutor(ports, RESIDENT)({
      machineId: "alpha",
      code: "tool.delegate(...)",
      timeoutMs: 5000,
    });

    expect(answer).toBe("ok");
    expect(calls).toEqual([{ status: "completed", value: "did: count the files" }]);
    expect(seen[0]?.origin).toEqual(RESIDENT);
  });

  it("refuses a machine tool named from inside a cell", async () => {
    const { kernel } = recordingDelegation();
    const registry = createCellRegistry();
    let refusal: Machine.ToolCallResult | undefined;
    const { ports } = cellPorts({
      delegation: kernel,
      registry,
      runCell: async (_machineId, request) => {
        refusal = await registry.callTool({
          cellId: request.cellId,
          name: RUN_CODE_TOOL_NAME,
          arguments: { machineId: "alpha", code: "pass", timeoutMs: 1000 },
        });
        return { status: "completed", cellId: request.cellId, output: { stdout: "done", stderr: "" } };
      },
    });

    await runCodeToolExecutor(ports, RESIDENT)({ machineId: "alpha", code: "x", timeoutMs: 5000 });

    // The cell is already on a machine; reaching back to reach another is the
    // round trip code mode removes. Placement says so — nothing restates it.
    expect(refusal?.status).toBe("failed");
    expect(refusal).toMatchObject({ error: expect.stringContaining('tool "run_code" requires capabilities') });
  });

  it("stops serving a cell's tools once the cell has settled", async () => {
    const { kernel } = recordingDelegation();
    const registry = createCellRegistry();
    let escaped: string | undefined;
    const { ports } = cellPorts({
      delegation: kernel,
      registry,
      runCell: async (_machineId, request) => {
        escaped = request.cellId;
        return { status: "completed", cellId: request.cellId, output: { stdout: "", stderr: "" } };
      },
    });

    await runCodeToolExecutor(ports, RESIDENT)({ machineId: "alpha", code: "x", timeoutMs: 5000 });

    const late = await registry.callTool({
      cellId: escaped ?? "",
      name: "delegate",
      arguments: { instruction: "late", mode: "ask", scope: "inline", timeoutMs: 1000 },
    });
    expect(late).toEqual({ status: "failed", error: `no tools are bound to cell ${escaped}` });
  });

  it("binds each cell to its own dispatcher, so one cell cannot borrow another's reach", async () => {
    const { kernel } = recordingDelegation();
    const registry = createCellRegistry();
    const worker = { role: "worker", depth: 1 } as const;

    // A worker with no delegation port holds an empty catalog.
    registry.bind("worker-cell", cellDoor(catalogEntries({}, worker)));
    registry.bind("resident-cell", cellDoor(catalogEntries({ delegation: kernel }, RESIDENT)));

    const fromWorker = await registry.callTool({
      cellId: "worker-cell",
      name: "delegate",
      arguments: { instruction: "escalate", mode: "ask", scope: "inline", timeoutMs: 1000 },
    });
    const fromResident = await registry.callTool({
      cellId: "resident-cell",
      name: "delegate",
      arguments: { instruction: "allowed", mode: "ask", scope: "inline", timeoutMs: 1000 },
    });

    expect(fromWorker).toEqual({ status: "failed", error: "unknown tool: delegate" });
    expect(fromResident.status).toBe("completed");
  });
});

describe("run_code outcomes", () => {
  const cases: Array<[string, Machine.CellResult | { status: "refused"; reason: "machine_not_attached" }, string]> = [
    ["a value", { status: "completed", cellId: "c", output: { stdout: "ignored", stderr: "" }, value: "42" }, "42"],
    ["stdout when there is no value", { status: "completed", cellId: "c", output: { stdout: "printed", stderr: "" } }, "printed"],
    ["a raise", { status: "raised", cellId: "c", output: { stdout: "", stderr: "trace" }, error: "ValueError" }, "the cell raised: ValueError\ntrace"],
    ["a timeout as unknown, not undone", { status: "timed_out", cellId: "c" }, "unknown, not undone"],
    ["a detached machine", { status: "refused", reason: "machine_not_attached" }, "not attached"],
  ];

  for (const [name, result, expected] of cases) {
    it(`reports ${name}`, async () => {
      const { kernel } = recordingDelegation();
      const { ports } = cellPorts({ delegation: kernel, runCell: async () => result as Machine.CellResult });
      const answer = await runCodeToolExecutor(ports, RESIDENT)({ machineId: "alpha", code: "x", timeoutMs: 250 });
      expect(answer).toContain(expected);
    });
  }

  it("refuses a malformed call before dispatching a cell", async () => {
    const { kernel } = recordingDelegation();
    let dispatched = false;
    const { ports } = cellPorts({
      delegation: kernel,
      runCell: async () => {
        dispatched = true;
        return { status: "timed_out", cellId: "c" };
      },
    });

    const answer = await runCodeToolExecutor(ports, RESIDENT)({ machineId: "alpha", code: "", timeoutMs: 250 });

    expect(answer).toStartWith("run_code refused:");
    expect(dispatched).toBe(false);
  });
});

describe("the advertised schema and the runtime gate agree", () => {
  it("rejects every key the JSON Schema does not advertise", async () => {
    const { kernel } = recordingDelegation();
    const { ports } = cellPorts({ delegation: kernel, runCell: async () => ({ status: "timed_out", cellId: "c" }) });
    const answer = await runCodeToolExecutor(ports, RESIDENT)({
      machineId: "alpha",
      code: "x",
      timeoutMs: 250,
      asRoot: true,
    });
    expect(answer).toStartWith("run_code refused:");
  });

  it("advertises exactly the keys the gate requires", () => {
    const { kernel } = recordingDelegation();
    const { ports } = cellPorts({ delegation: kernel, runCell: async () => ({ status: "timed_out", cellId: "c" }) });
    const spec = catalogEntries({ delegation: kernel, cells: ports }, RESIDENT).find(
      (e: CatalogEntry) => e.spec.name === RUN_CODE_TOOL_NAME,
    )?.spec;
    const schema = spec?.inputSchema as { required: string[]; properties: Record<string, unknown> };

    expect(schema.required.sort()).toEqual(["code", "machineId", "timeoutMs"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["code", "machineId", "timeoutMs"]);
  });
});
