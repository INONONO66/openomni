import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type BusEvent } from "@openomni/protocol";
import { createSessionKernel } from "../src/core/store/fence";
import { openCatalogStore } from "../src/core/store/catalog";
import { openSessionStore } from "../src/core/store/session-file";
import { runLedgerSync } from "./store/helpers/effect";
import { testNow } from "./store/helpers/storage";

/**
 * #1252 read degradation: a journal row whose stored payload no longer decodes
 * is kept verbatim on disk, emits exactly one `journal.corrupt{seq, kind,
 * reason}` observation, and folds as opaque — one bad row never blocks
 * session load.
 */
test("a corrupt row degrades to opaque with one journal.corrupt observation and the session still loads", () => {
  const directory = mkdtempSync(join(tmpdir(), "journal-corrupt-"));
  const path = join(directory, "s1.sqlite");
  const corrupt: Journal.Corrupt[] = [];
  const sink = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T) {
      if (event.name === "journal.corrupt") corrupt.push(Journal.Corrupt.parse(data));
    },
  };
  const session = openSessionStore(path, { now: testNow, observationSink: sink });
  const catalog = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow });
  try {
    const kernel = createSessionKernel(session, catalog);
    runLedgerSync(
      kernel.materialize({
        id: "s1",
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 0,
        actionId: "s1:configure",
        at: 1,
      }),
    );
    const row = kernel.row("s1");
    runLedgerSync(
      kernel.commit({
        sessionId: "s1",
        owner: "owner-1",
        fence: runLedgerSync(kernel.adoptFence({ sessionId: "s1", owner: "owner-1", fence: 1 })).fence,
        now: 2,
        expectedRevision: row.revision,
        state: "idle",
        actions: [
          {
            id: "s1:prompt",
            parentId: "s1:configure",
            sessionId: "s1",
            kind: "prompt",
            intent: { encodingVersion: 1, value: { origin: "human" } },
            effect: { encodingVersion: 1, value: { inboxKind: "prompt", content: "hello" } },
            irreversible: true,
            ts: 2,
          },
        ],
      }),
    );
    // Corrupt the stored payload bytes directly (bypassing the fail-closed
    // write CHECKs, as on-disk corruption would): decode must now fail.
    const raw = new Database(path);
    try {
      raw.run("PRAGMA ignore_check_constraints = ON");
      raw.run("UPDATE action SET encoding_version = 99 WHERE id = 's1:prompt'");
    } finally {
      raw.close();
    }

    const loaded = session.actions.range("s1", 0, 256);
    // Session load survives: the undecodable row stays verbatim on disk,
    // folds as opaque (skipped from the projection) and blocks nothing.
    expect(loaded.map((action) => action.id)).toEqual(["s1:configure"]);
    // Exactly one journal.corrupt observation names the row.
    expect(corrupt).toMatchObject([{ seq: 2, kind: "prompt" }]);
    expect(corrupt[0]?.reason.length).toBeGreaterThan(0);
    // Verbatim on disk: the degraded read rewrote nothing.
    const after = new Database(path, { readonly: true });
    try {
      expect(
        after.query("SELECT intent, encoding_version FROM action WHERE id = 's1:prompt'").get(),
      ).toMatchObject({ encoding_version: 99 });
    } finally {
      after.close();
    }
  } finally {
    session.close();
    catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
