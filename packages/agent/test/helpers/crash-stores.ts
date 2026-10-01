import { openCatalogStore, openSessionStore, SessionHandleStore } from "@openomni/ledger";
import type { createObservationBus } from "../../src/observation/bus";
import { testBus } from "./bus";
import type { IsolatedLedgerHandle } from "./isolated";

export type CrashStores = IsolatedLedgerHandle & { readonly dbPath: string };

/**
 * The handle-scoped store layout crash children and their inspecting parents
 * share (W5.2 F1): the session file at `dbPath`, the catalog beside it. No
 * process-global storage — every opener owns and closes its handles.
 */
export function openCrashStores(dbPath: string): CrashStores {
  const bus = testBus();
  let now = 0;
  const storeOptions = { now: () => (now += 1), observationSink: bus };
  const session = openSessionStore(dbPath, storeOptions);
  const catalog = openCatalogStore(`${dbPath}.catalog`, storeOptions);
  const kernel = SessionHandleStore.createSessionKernel(session, catalog);
  return {
    dbPath,
    session,
    catalog,
    kernel,
    openKernel: () => kernel,
    listSessions: () => kernel.listRows(),
    bus,
    close: () => {
      session.close();
      catalog.close();
    },
  };
}
