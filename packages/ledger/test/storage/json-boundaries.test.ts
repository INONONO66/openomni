import { expect, test } from "bun:test";
import { LedgerSession } from "@openomni/protocol";
import { createSqliteActorRegistryAdapter } from "../../src/storage/sqlite-actor-registry-adapter";
import { createSqliteL0Adapters } from "../../src/storage/sqlite-l0-adapter";
import { Ledger } from "../../src/ledger-core";
import { openLedgerDatabase } from "../helpers/ledger";

test("raw recorded facts reject malformed JSON and non-finite JSON numbers", () => {
  using db = openLedgerDatabase();
  Ledger.append(db, { streamId: "boundary", type: "test", data: {}, timeCreated: 1 }, 0);
  for (const corrupt of ["{", "1e999"]) {
    db.query("UPDATE ledger_event SET data = ? WHERE stream_id = ?").run(corrupt, "boundary");
    expect(() => Ledger.headFact(db, "boundary")).toThrow();
    expect(() => Ledger.factsByType(db, "test")).toThrow();
  }
  db.query("UPDATE ledger_event SET data = ? WHERE stream_id = ?").run(
    '{"valid":[1,null]}',
    "boundary",
  );
  expect(Ledger.headFact(db, "boundary")?.data).toEqual({ valid: [1, null] });
});

test("actor endpoint filters distinguish no filter from the empty workspace", () => {
  using db = openLedgerDatabase();
  const store = createSqliteActorRegistryAdapter(db);
  for (const id of ["a", "b"]) store.setIdentity({ id, kind: "human", trustTier: "observer" });
  for (const [id, actorId, workspace] of [
    ["1", "a", ""],
    ["2", "a", "guild"],
    ["3", "b", "guild"],
  ] as const) {
    store.setEndpoint({
      id,
      actorId,
      workspace: workspace || undefined,
      channel: "discord",
      externalId: id,
      createdAt: 1,
      updatedAt: 1,
    });
  }
  expect(store.listEndpoints().map((row) => row.id)).toEqual(["1", "2", "3"]);
  expect(store.listEndpoints("a").map((row) => row.id)).toEqual(["1", "2"]);
  expect(store.listEndpoints(undefined, "guild").map((row) => row.id)).toEqual(["2", "3"]);
  expect(store.listEndpoints("b", "guild").map((row) => row.id)).toEqual(["3"]);
  expect(store.listEndpoints(undefined, "").map((row) => row.id)).toEqual(["1"]);
  db.query("UPDATE actor_endpoint SET data = ? WHERE id = '2'").run('{"id":"2"}');
  expect(() => store.getEndpoint("2")).toThrow();
  expect(() => store.findEndpoint("discord", "2", "guild")).toThrow();
  expect(() => store.listEndpoints("a")).toThrow();
});

test("action reads validate scalar driver columns and JSON before replay", () => {
  using db = openLedgerDatabase();
  const store = createSqliteL0Adapters(db, (operation) => db.transaction(operation).immediate(), {
    publish: () => undefined,
  });
  store.sessions.create(
    LedgerSession.Row.parse({
      id: "s",
      parentId: null,
      role: "resident",
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      revision: 0,
      state: "idle",
    }),
  );
  store.actions.append(
    {
      id: "a",
      parentId: null,
      sessionId: "s",
      kind: "tool",
      intent: { encodingVersion: 1, value: {} },
      effect: { encodingVersion: 1, value: {} },
      irreversible: true,
      ts: 1,
    },
    0,
  );
  db.run("PRAGMA ignore_check_constraints = ON");
  db.run("UPDATE action SET irreversible = 2");
  expect(() => store.actions.tree("s")).toThrow();
  expect(() => store.actions.range("s", 0, 10)).toThrow();
  db.run("UPDATE action SET irreversible = 1, intent = '1e999'");
  expect(() => store.actions.tree("s")).toThrow();
  db.run("UPDATE action SET intent = '{}'");
  expect(store.actions.tree("s")).toHaveLength(1);
});
