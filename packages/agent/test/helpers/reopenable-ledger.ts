import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogStore } from "../../src/store/catalog";
import { openSessionStore } from "../../src/store/session-file";
import * as SessionHandleStore from "../../src/store/fence";
import { testBus } from "./bus";
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
  const bus = testBus();
  let now = 0;
  const storeOptions = { now: () => (now += 1), observationSink: bus };
  const open = () => {
    const sessionStore = openSessionStore(join(directory, "chat.sqlite"), storeOptions);
    const catalog = openCatalogStore(join(directory, "catalog.sqlite"), storeOptions);
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
      bus.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
