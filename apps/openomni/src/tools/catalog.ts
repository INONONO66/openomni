import type { ChatAgentConfig } from "@openomni/agent";
import { placementGatedExecutor } from "@openomni/agent";
import { Placement } from "@openomni/placement";
import type { Tool } from "@openomni/protocol";
import type { DelegationOrigin } from "../delegation/admission";
import type { DelegationKernel } from "../delegation/kernel";
import { delegateToolExecutor, delegateToolSpec } from "../delegation/tool";
import type { CellPorts } from "./run-code";
import { runCodeToolExecutor, runCodeToolSpec } from "./run-code";

/**
 * The brain as a placement target. Declaring no capabilities is the honest
 * reading: the host runs host- and free-placed tools, and claims none of the
 * machine capabilities a `requires` could name.
 */
export const HOST_TARGET: Placement.ToolTarget = { kind: "host", capabilities: [] };

/** A tool as the app holds it: what the model is told, and what running it does. */
export interface CatalogEntry {
  readonly spec: Tool.Spec;
  run(input: unknown): Promise<string>;
}

export interface CatalogPorts {
  readonly delegation?: DelegationKernel;
  readonly cells?: CellPorts;
}

/**
 * Every tool this app could offer, before placement has an opinion.
 *
 * A port that is not wired contributes no entry: a capability the app does
 * not have is absent from the catalog rather than present and always
 * refusing. Entries are built per originator because a tool is bound to who
 * is running it — the same reason the delegate tool takes an origin.
 */
export function catalogEntries(
  ports: CatalogPorts,
  origin: DelegationOrigin,
): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  if (ports.delegation !== undefined) {
    entries.push({
      spec: delegateToolSpec(),
      run: delegateToolExecutor(ports.delegation, origin),
    });
  }
  if (ports.cells !== undefined) {
    entries.push({
      spec: runCodeToolSpec(),
      run: runCodeToolExecutor(ports.cells, origin),
    });
  }
  return entries;
}

export interface Dispatcher {
  /** The whole catalog. Who may be offered what is placement's question. */
  readonly specs: Tool.Spec[];
  /** Runs a call by name. Ungated: every door gates once, and states where. */
  readonly execute: NonNullable<ChatAgentConfig["toolExecutor"]>;
}

/**
 * Turns a catalog into "a name runs a tool", and nothing more.
 *
 * The two doors into this catalog gate differently, so neither gate lives
 * here: the agent loop gates what the model calls against the turn's targets,
 * and `cellDoor` gates what a running cell calls against the brain alone.
 */
export function createDispatcher(entries: readonly CatalogEntry[]): Dispatcher {
  const known = new Map(entries.map((entry) => [entry.spec.name, entry]));

  return {
    specs: entries.map((entry) => entry.spec),
    execute: async (call) => {
      const entry = known.get(call.tool);
      return entry === undefined
        ? {
            toolCallId: call.id,
            id: call.id,
            toolName: call.tool,
            output: `unknown tool: ${call.tool}`,
            isError: true,
          }
        : {
            toolCallId: call.id,
            id: call.id,
            toolName: call.tool,
            output: await entry.run(call.input),
          };
    },
  };
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
