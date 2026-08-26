import type { Tool } from "@openomni/protocol";
import type { DelegationOrigin } from "../delegation/admission";
import type { DelegationKernel } from "../delegation/kernel";
import {
  awaitDelegationToolExecutor,
  awaitDelegationToolSpec,
  cancelDelegationToolExecutor,
  cancelDelegationToolSpec,
  delegateToolExecutor,
  delegateToolSpec,
} from "../delegation/tool";
import type { CuratedMemory } from "../memory/store";
import type { CatalogEntry } from "./dispatch";
import { memoryToolExecutor, memoryToolSpec } from "./memory";
import type { MachinesPort } from "./machines";
import { machinesToolExecutor, machinesToolSpec } from "./machines";
import type { CellPorts } from "./run-code";
import { runCodeToolExecutor, runCodeToolSpec } from "./run-code";

export interface CatalogPorts {
  readonly delegation?: DelegationKernel;
  readonly cells?: CellPorts;
  readonly machines?: MachinesPort;
  readonly memory?: CuratedMemory;
}

type ToolRun = CatalogEntry["run"];

interface CatalogTool {
  readonly spec: () => Tool.Spec;
  /**
   * The capability gate: a port that is not wired contributes no entry — a
   * capability the app does not have is absent from the catalog rather than
   * present and always refusing.
   */
  readonly wire: (ports: CatalogPorts, origin: DelegationOrigin) => ToolRun | undefined;
}

/**
 * Every tool this app could offer, before placement has an opinion — the one
 * list both the catalog and the repository lint read, so a spec cannot exist
 * here without being wireable, or ship without being linted.
 */
const CATALOG_TOOLS: readonly CatalogTool[] = [
  {
    spec: delegateToolSpec,
    wire: (ports, origin) =>
      ports.delegation === undefined ? undefined : delegateToolExecutor(ports.delegation, origin),
  },
  {
    spec: awaitDelegationToolSpec,
    wire: (ports) =>
      ports.delegation === undefined ? undefined : awaitDelegationToolExecutor(ports.delegation),
  },
  {
    spec: cancelDelegationToolSpec,
    wire: (ports) =>
      ports.delegation === undefined ? undefined : cancelDelegationToolExecutor(ports.delegation),
  },
  {
    spec: runCodeToolSpec,
    wire: (ports, origin) =>
      ports.cells === undefined ? undefined : runCodeToolExecutor(ports.cells, origin),
  },
  {
    spec: machinesToolSpec,
    wire: (ports) =>
      ports.machines === undefined ? undefined : machinesToolExecutor(ports.machines),
  },
  {
    // Memory is owner-scoped (kernel-contract §5): the Resident curates it,
    // a delegated worker never sees or writes it. Role, not port wiring,
    // is the gate — the same store is wired once at the composition root.
    spec: memoryToolSpec,
    wire: (ports, origin) =>
      ports.memory === undefined || origin.role !== "resident"
        ? undefined
        : memoryToolExecutor(ports.memory),
  },
];

/** Every spec the app can ship, as data — no ports, no origin: the repository lint's seam. */
export function collectToolSpecs(): readonly Tool.Spec[] {
  return CATALOG_TOOLS.map((tool) => tool.spec());
}

/**
 * Every tool this app could offer, before placement has an opinion.
 *
 * Entries are built per originator because a tool is bound to who is running
 * it — the same reason the delegate tool takes an origin.
 */
export function catalogEntries(
  ports: CatalogPorts,
  origin: DelegationOrigin,
): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const tool of CATALOG_TOOLS) {
    const run = tool.wire(ports, origin);
    if (run !== undefined) {
      entries.push({ spec: tool.spec(), run });
    }
  }
  return entries;
}
