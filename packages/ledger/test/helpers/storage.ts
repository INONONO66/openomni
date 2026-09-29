import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservationSink } from "@openomni/protocol";
import { openCatalogStore, openSessionStore, SessionHandleStore } from "../../src";

type SessionStore = ReturnType<typeof openSessionStore>;
type CatalogStore = ReturnType<typeof openCatalogStore>;

export interface LedgerStores {
  readonly session: SessionStore;
  readonly catalog: CatalogStore;
  readonly kernel: SessionHandleStore.SessionKernel;
}

function open(paths: { session: string; catalog: string }, sink?: ObservationSink): LedgerStores {
  const session = openSessionStore(paths.session, sink);
  const catalog = openCatalogStore(paths.catalog, sink);
  return { session, catalog, kernel: SessionHandleStore.createSessionKernel(session, catalog) };
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
