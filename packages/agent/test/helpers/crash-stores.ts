import { openCatalogStore, openSessionStore, SessionHandleStore } from "@openomni/ledger";
import { createObservationBus } from "../../src/observation/bus";
import type { IsolatedLedgerHandle } from "./isolated";

export type CrashStores = IsolatedLedgerHandle;

/**
 * The handle-scoped store layout crash children and their inspecting parents
 * share (W5.2 F1): the session file at `dbPath`, the catalog beside it. No
 * process-global storage — every opener owns and closes its handles.
 */
export function openCrashStores(dbPath: string): CrashStores {
  const bus = createObservationBus();
  const session = openSessionStore(dbPath, bus);
  const catalog = openCatalogStore(`${dbPath}.catalog`, bus);
  const kernel = SessionHandleStore.createSessionKernel(session, catalog);
  return {
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
