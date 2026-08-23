import type { DelegationOrigin } from "../delegation/admission";
import type { DelegationKernel } from "../delegation/kernel";
import { delegateToolExecutor, delegateToolSpec } from "../delegation/tool";
import type { CatalogEntry } from "./dispatch";
import type { CellPorts } from "./run-code";
import { runCodeToolExecutor, runCodeToolSpec } from "./run-code";

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
