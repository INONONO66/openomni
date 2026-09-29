import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogStore, openSessionStore, SessionHandleStore } from "@openomni/ledger";
import { createObservationBus } from "../../src/observation/bus";
import type { IsolatedLedgerHandle } from "./isolated";

/**
 * File-backed isolation (W5.2): the Storage singleton is gone, so reopen is a
 * store close + fresh open over the same SQLite files, behind the isolation's
 * lazy `isolatedLedger()` pointer.
 */
export function reopenableLedger(
  prefix: string,
): IsolatedLedgerHandle & { readonly reopen: () => void } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const bus = createObservationBus();
  const open = () => {
    const sessionStore = openSessionStore(join(directory, "chat.sqlite"), bus);
    const catalog = openCatalogStore(join(directory, "catalog.sqlite"), bus);
    return {
      sessionStore,
      catalog,
      kernel: SessionHandleStore.createSessionKernel(sessionStore, catalog),
    };
  };
  let current = open();
  return {
    get kernel() {
      return current.kernel;
    },
    openKernel: () => current.kernel,
    listSessions: () => current.kernel.listRows(),
    get session() {
      return current.sessionStore;
    },
    get catalog() {
      return current.catalog;
    },
    bus,
    reopen: () => {
      current.sessionStore.close();
      current.catalog.close();
      current = open();
    },
    close: () => {
      current.sessionStore.close();
      current.catalog.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
