import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservationSink } from "@openomni/protocol";
import { openCatalogStore, openSessionStore, SessionHandleStore } from "../../src";

/** Fixed injected clock (#1245): ledger tests assert exact timestamps. */
export const TEST_NOW = 1_700_000_000_000;
export const testNow = (): number => TEST_NOW;

type SessionStore = ReturnType<typeof openSessionStore>;
type CatalogStore = ReturnType<typeof openCatalogStore>;

export interface LedgerStores {
  readonly session: SessionStore;
  readonly catalog: CatalogStore;
  readonly kernel: SessionHandleStore.SessionKernel;
}

function open(paths: { session: string; catalog: string }, sink?: ObservationSink): LedgerStores {
  const session = openSessionStore(paths.session, { now: testNow, observationSink: sink });
  const catalog = openCatalogStore(paths.catalog, { now: testNow, observationSink: sink });
  return { session, catalog, kernel: SessionHandleStore.createSessionKernel(session, catalog) };
}

function accessors(current: () => LedgerStores): LedgerStores {
  return {
    get session() {
      return current().session;
    },
    get catalog() {
      return current().catalog;
    },
    get kernel() {
      return current().kernel;
    },
  };
}

/** Fresh in-memory session + catalog stores and a kernel over them, per test. */
export function useMemoryStores(sink?: ObservationSink): LedgerStores {
  let stores: LedgerStores | undefined;
  beforeEach(() => {
    stores = open({ session: ":memory:", catalog: ":memory:" }, sink);
  });
  afterEach(() => {
    stores?.session.close();
    stores?.catalog.close();
    stores = undefined;
  });
  const current = (): LedgerStores => {
    if (stores === undefined) throw new Error("stores are only open inside a test");
    return stores;
  };
  return accessors(current);
}

/** Own one real on-disk session+catalog pair per test; `reopen` survives restarts. */
export function useSqliteStores(label: string) {
  let directory = "";
  let stores: LedgerStores | undefined;
  const paths = { session: "", catalog: "" };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), `${label}-`));
    paths.session = join(directory, "session.sqlite");
    paths.catalog = join(directory, "catalog.sqlite");
    stores = open(paths);
  });
  afterEach(() => {
    stores?.session.close();
    stores?.catalog.close();
    stores = undefined;
    rmSync(directory, { recursive: true });
  });
  const current = (): LedgerStores => {
    if (stores === undefined) throw new Error("stores are only open inside a test");
    return stores;
  };
  const live = accessors(current);
  return {
    get session() {
      return live.session;
    },
    get catalog() {
      return live.catalog;
    },
    get kernel() {
      return live.kernel;
    },
    get sessionPath() {
      return paths.session;
    },
    get catalogPath() {
      return paths.catalog;
    },
    reopen() {
      current().session.close();
      current().catalog.close();
      stores = open(paths);
    },
  };
}
