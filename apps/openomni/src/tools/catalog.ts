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
    entries.push(
      {
        spec: delegateToolSpec(),
        run: delegateToolExecutor(ports.delegation, origin),
      },
      {
        spec: awaitDelegationToolSpec(),
        run: awaitDelegationToolExecutor(ports.delegation),
      },
      {
        spec: cancelDelegationToolSpec(),
        run: cancelDelegationToolExecutor(ports.delegation),
      },
    );
  }
  if (ports.cells !== undefined) {
    entries.push({
      spec: runCodeToolSpec(),
      run: runCodeToolExecutor(ports.cells, origin),
    });
  }
  if (ports.machines !== undefined) {
    entries.push({
      spec: machinesToolSpec(),
      run: machinesToolExecutor(ports.machines),
    });
  }
  // Memory is owner-scoped (kernel-contract §5): the Resident curates it,
  // a delegated worker never sees or writes it. Role, not port wiring,
  // is the gate — the same store is wired once at the composition root.
  if (ports.memory !== undefined && origin.role === "resident") {
    entries.push({
      spec: memoryToolSpec(),
      run: memoryToolExecutor(ports.memory),
    });
  }
  return entries;
}
