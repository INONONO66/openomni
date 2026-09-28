import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { runLedgerSync } from "../helpers/effect";
import * as Ledger from "../../src";
import { CatalogStore } from "../../src/storage/catalog-store";

test("borrowed LedgerLive serves the supplied handles without closing them", () => {
  const catalog = Ledger.openCatalogStore(":memory:");
  const close = spyOn(catalog, "close");
  const opened: string[] = [];
  const handles: Ledger.LedgerHandles = {
    catalog,
    openSession: (sessionId) => {
      opened.push(sessionId);
      return Ledger.openSessionStore(":memory:");
    },
  };
  try {
    const writes = runLedgerSync(
      Ledger.LedgerWrites.pipe(Effect.provide(Ledger.LedgerLive(handles))),
    );
    expect(writes.catalog).toBe(catalog);
    const session = writes.openSession("layer-session");
    try {
      expect(opened).toEqual(["layer-session"]);
      expect(session.sessions.list()).toEqual([]);
    } finally {
      session.close();
    }
    expect(close).not.toHaveBeenCalled();
  } finally {
    close.mockRestore();
    catalog.close();
  }
});

test("LedgerCatalogLive owns the catalog handle and closes it with the scope", () => {
  const directory = mkdtempSync(join(tmpdir(), "ledger-catalog-live-"));
  const close = spyOn(CatalogStore.prototype, "close");
  try {
    const scope = runLedgerSync(Scope.make());
    const writes = runLedgerSync(
      Layer.build(
        Ledger.LedgerCatalogLive({
          catalogPath: join(directory, "catalog.sqlite"),
          sessionsDir: join(directory, "sessions"),
        }),
      ).pipe(
        Scope.provide(scope),
        Effect.map((context) => Context.get(context, Ledger.LedgerWrites)),
      ),
    );
    expect(existsSync(join(directory, "catalog.sqlite"))).toBe(true);
    expect(writes.catalog.rotateFence).toBeFunction();
    const session = writes.openSession("s1");
    try {
      expect(existsSync(join(directory, "sessions", "s1.sqlite"))).toBe(true);
      expect(session.sessions.list()).toEqual([]);
    } finally {
      session.close();
    }
    expect(close).not.toHaveBeenCalled();
    runLedgerSync(Scope.close(scope, Exit.void));
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opening an invalid catalog path fails in the ledger error channel", () => {
  const directory = mkdtempSync(join(tmpdir(), "ledger-open-refusal-"));
  try {
    const error = runLedgerSync(
      Effect.flip(
        Effect.scoped(
          Ledger.LedgerWrites.pipe(
            Effect.provide(
              Ledger.LedgerCatalogLive({ catalogPath: directory, sessionsDir: directory }),
            ),
          ),
        ),
      ),
    );
    expect(error).toMatchObject({ _tag: "ForeignFailure", operation: "ledger.open" });
    if (error._tag !== "ForeignFailure") throw new Error("expected ForeignFailure");
    expect(error.cause.length).toBeGreaterThan(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
