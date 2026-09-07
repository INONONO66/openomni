import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDispositionFixture,
  seedRetiredWait,
  snapshotDatabase,
} from "../helpers/disposition-967";
import { assertArchiveEquality } from "../../../../script/ledger-archive-snapshot";
import { sqliteSchema } from "../../src/storage/u967-preflight";
import { preflight969 } from "../../src/storage/u969-preflight";
import { Migration } from "../../src/storage/migration-runner";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";
import { archiveCli, disposeCli } from "../helpers/disposition-967-cli";

const migrationDir = join(import.meta.dir, "../../migration");

test("the real archive CLI verifies old native images after terminal request cutover", () => {
  using fixture = createDispositionFixture(false);
  fixture.db.run(`UPDATE wait SET status='cancelled',revision=1,time_updated=2,
    data=json_set(data,'$.status','cancelled','$.revision',1,'$.updatedAt',2,'$.cancelledAt',2)`);
  expect(archiveCli(fixture, [], false).exitCode).toBe(0);
  expect(disposeCli(fixture, false).exitCode).toBe(0);
  const archive = readFileSync(fixture.archive);
  initializeSqliteDatabase(fixture.db);
  const before = snapshotDatabase(fixture.db);
  expect(archiveCli(fixture, ["--verify"], false).exitCode).toBe(0);
  expect(disposeCli(fixture, false).exitCode).toBe(0);
  expect(snapshotDatabase(fixture.db)).toEqual(before);
  expect(readFileSync(fixture.archive)).toEqual(archive);
});

function upgradeFixture() {
  const fixture = createDispositionFixture(false);
  fixture.db.run("DELETE FROM wait");
  fixture.db.run("DELETE FROM bus_event");
  Migration.applyOrdered(fixture.db, migrationDir, [
    { name: "0034_u967_archive_disposition/migration.sql" },
    { name: "0035_drop_retired_delegation_tables/migration.sql" },
  ]);
  return fixture;
}

test("0035 upgrade preserves action parents, rowids, policies and native archive bytes", () => {
  using fixture = upgradeFixture();
  const db = fixture.db;
  db.run(`INSERT INTO action
    (rowid,id,parent_id,session_id,kind,intent,effect,irreversible,encoding_version,ts,ordinal)
    VALUES (17,'child','attempt-history','legacy','tool','{ "x": 1 }','{}',1,1,2,2)`);
  db.run(`INSERT INTO policy VALUES ('old','tool','pre','{}','{}',1,0,1)`);
  db.run(`INSERT INTO approval VALUES (
    'settled', '{ "id":"settled","subject":{"kind":"contact_promotion","actorId":"a"},
    "requestedBy":"resident","deadline":10,"state":"refused","revision":1,
    "createdAt":1,"updatedAt":2,"decidedAt":2,"decidedBy":"owner" }',
    1,'refused',10,1,2)`);
  const before = snapshotDatabase(db);
  initializeSqliteDatabase(db);
  for (const table of [
    "action",
    "policy",
    "session",
    "inbox",
    "alarm",
    "ledger_event",
    "event_chain",
  ]) {
    expect(snapshotDatabase(db).tables.find(({ name }) => name === table)).toEqual(
      before.tables.find(({ name }) => name === table),
    );
  }
  const approvals = before.tables.find(({ name }) => name === "approval");
  if (!approvals) throw new Error("historical approval table missing");
  expect(db.query("SELECT rowid,* FROM archive_969_approval").all()).toEqual(approvals.rows);
  expect(
    db.query("SELECT name FROM sqlite_master WHERE name IN ('wait','approval')").all(),
  ).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  using fresh = new Database(":memory:");
  initializeSqliteDatabase(fresh);
  expect(sqliteSchema(db)).toEqual(sqliteSchema(fresh));
  expect(() => db.run("DELETE FROM archive_969_approval")).toThrow("immutable_archive");
  expect(() => db.run("UPDATE archive_969_approval SET data = '{}'")).toThrow("immutable_archive");
  expect(() =>
    db.run("INSERT INTO archive_969_approval SELECT * FROM archive_969_approval"),
  ).toThrow("immutable_archive");
  initializeSqliteDatabase(db);
});

test.each([
  "resolved",
  "expired",
  "cancelled",
] as const)("terminal %s correlation bytes remain immutable and old archives verify after cutover", (status) => {
  using fixture = upgradeFixture();
  seedRetiredWait(fixture.db, status);
  fixture.db.run("UPDATE wait SET data = '  ' || data || char(10)");
  copyFileSync(fixture.path, fixture.archive);
  using archived = new Database(fixture.archive, { readonly: true, safeIntegers: true });
  const before = archived.query("SELECT rowid,* FROM wait").all();
  initializeSqliteDatabase(fixture.db);
  expect(fixture.db.query("SELECT rowid,* FROM archive_969_wait").all()).toEqual(before);
  expect(() => assertArchiveEquality(fixture.db, archived, true)).not.toThrow();
  expect(() => fixture.db.run("DELETE FROM archive_969_wait")).toThrow("immutable_archive");
  expect(() => fixture.db.run("UPDATE archive_969_wait SET data = '{}'")).toThrow(
    "immutable_archive",
  );
  expect(() =>
    fixture.db.run("INSERT INTO archive_969_wait SELECT * FROM archive_969_wait"),
  ).toThrow("immutable_archive");
});

test.each([
  "UPDATE wait SET revision = 99",
  "UPDATE wait SET data = '{'",
  `UPDATE wait SET data = replace(data, '"id":"retired"', '"id":"other","id":"retired"')`,
  "UPDATE wait SET follow_up_until = 999",
])("malformed legacy correlation refuses unchanged: %s", (fault) => {
  using fixture = upgradeFixture();
  seedRetiredWait(fixture.db);
  fixture.db.run(fault);
  const before = snapshotDatabase(fixture.db);
  const bytes = readFileSync(fixture.path);
  expect(() => initializeSqliteDatabase(fixture.db)).toThrow("wait:retired");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
  expect(readFileSync(fixture.path)).toEqual(bytes);
});

test("resolved follow-up boundary refuses inclusively without treating expiry as an answer", () => {
  using fixture = upgradeFixture();
  seedRetiredWait(fixture.db, "resolved");
  expect(() => preflight969(fixture.db, 102)).toThrow("wait:retired");
  expect(() => preflight969(fixture.db, 103)).not.toThrow();
});

test("mid-migration foreign-key failure rolls back archives table drops and history", () => {
  using fixture = upgradeFixture();
  fixture.db.run("PRAGMA foreign_keys = OFF");
  fixture.db.run("UPDATE action SET parent_id = 'missing'");
  fixture.db.run("PRAGMA foreign_keys = ON");
  const before = snapshotDatabase(fixture.db);
  expect(() =>
    Migration.applyOrdered(fixture.db, migrationDir, [
      { name: "0038_session_requests/migration.sql" },
    ]),
  ).toThrow("request_migration_foreign_key_violation");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
  expect(fixture.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1n });
});

test("fresh storage accepts request reply outbound action and policy kinds", () => {
  using db = new Database(":memory:");
  initializeSqliteDatabase(db);
  db.run("INSERT INTO session (id,data,time_created,time_updated) VALUES ('s','{}',1,1)");
  let ordinal = 0;
  for (const kind of ["request", "reply", "outbound"]) {
    db.query(`INSERT INTO action
      (id,session_id,kind,intent,effect,irreversible,encoding_version,ts,ordinal)
      VALUES (?,'s',?,'{}','{}',1,1,1,?)`).run(kind, kind, ++ordinal);
    db.query("INSERT INTO policy VALUES (?,?,'pre','{}','{}',1,0,1)").run(kind, kind);
  }
  expect(db.query("SELECT kind FROM action ORDER BY ordinal").all()).toEqual([
    { kind: "request" },
    { kind: "reply" },
    { kind: "outbound" },
  ]);
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
});

test.each([
  "pending",
  "malformed",
])("refuses %s legacy approval before changing database bytes", (state) => {
  using fixture = upgradeFixture();
  fixture.db.run("INSERT INTO approval VALUES ('unsafe','{}',0,?,10,1,1)", [state]);
  const before = snapshotDatabase(fixture.db);
  const bytes = readFileSync(fixture.path);
  expect(() => initializeSqliteDatabase(fixture.db)).toThrow("approval:unsafe");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
  expect(readFileSync(fixture.path)).toEqual(bytes);
});

test("refuses unresolved legacy correlation without synthesizing an invocation", () => {
  using fixture = createDispositionFixture(false);
  fixture.db.run("DELETE FROM bus_event");
  Migration.applyOrdered(fixture.db, migrationDir, [
    { name: "0034_u967_archive_disposition/migration.sql" },
    { name: "0035_drop_retired_delegation_tables/migration.sql" },
  ]);
  const before = snapshotDatabase(fixture.db);
  const bytes = readFileSync(fixture.path);
  expect(() => initializeSqliteDatabase(fixture.db)).toThrow("wait:preserved");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
  expect(readFileSync(fixture.path)).toEqual(bytes);
});

test.each(["armed", "paused"] as const)(
  "refuses %s legacy message deadline before PRAGMAs and under the migration lock",
  (status) => {
    using fixture = upgradeFixture();
    fixture.db.run(
      `UPDATE alarm SET status=?,spec=? WHERE id='armed-alarm'`,
      [status, JSON.stringify({
        kind: "message_deadline",
        messageId: "native-message",
        sourceActionId: "attempt-history",
        replyTo: "native-original",
        generation: { toolsGeneration: 1, systemHash: "system", policyGeneration: 0 },
      })],
    );
    const before = snapshotDatabase(fixture.db);
    const bytes = readFileSync(fixture.path);
    for (const upgrade of [
      () => initializeSqliteDatabase(fixture.db),
      () => Migration.applyOrdered(fixture.db, migrationDir, [
        { name: "0038_session_requests/migration.sql" },
      ]),
    ]) {
      expect(upgrade).toThrow("alarm:armed-alarm");
      expect(snapshotDatabase(fixture.db)).toEqual(before);
      expect(readFileSync(fixture.path)).toEqual(bytes);
    }
  },
);

test.each(["fired", "cancelled"] as const)(
  "retains terminal %s legacy message deadline bytes without reviving authority",
  (status) => {
    using fixture = upgradeFixture();
    fixture.db.run(
      `UPDATE alarm SET status=?,spec=? WHERE id='armed-alarm'`,
      [status, '{ "kind": "message_deadline", "sourceActionId": "attempt-history" }'],
    );
    const before = fixture.db.query("SELECT rowid,* FROM alarm").all();
    initializeSqliteDatabase(fixture.db);
    expect(fixture.db.query("SELECT rowid,* FROM alarm").all()).toEqual(before);
  },
);

test.each([
  "missing-source",
  "source-without-request",
  "wrong-source-session",
  "missing-origin",
] as const)("refuses pending native child input with %s unchanged", (fault) => {
  using fixture = upgradeFixture();
  fixture.db.run(
    `INSERT INTO session (id,data,time_created,time_updated,role)
     VALUES ('parent','{}',1,1,'resident')`,
  );
  fixture.db.run("UPDATE session SET role='worker',parent_id='parent' WHERE id='legacy'");
  fixture.db.run(
    "UPDATE action SET session_id='parent',kind='message' WHERE id='attempt-history'",
  );
  fixture.db.run(
    `UPDATE inbox SET origin=? WHERE id='pending-inbox'`,
    [JSON.stringify(fault === "missing-origin" ? {} : {
      kind: "message",
      messageId: "native-message",
      senderSessionId: fault === "wrong-source-session" ? "foreign" : "parent",
      sourceActionId: fault === "missing-source" ? "missing" : "attempt-history",
      deadline: 100,
    })],
  );
  const before = snapshotDatabase(fixture.db);
  const bytes = readFileSync(fixture.path);
  expect(() => initializeSqliteDatabase(fixture.db)).toThrow("inbox:pending-inbox");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
  expect(readFileSync(fixture.path)).toEqual(bytes);
  expect(() => Migration.applyOrdered(fixture.db, migrationDir, [
    { name: "0038_session_requests/migration.sql" },
  ])).toThrow("inbox:pending-inbox");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
  expect(readFileSync(fixture.path)).toEqual(bytes);
});

test("consumed native child history and unrelated pending root input remain byte-identical", () => {
  using fixture = upgradeFixture();
  fixture.db.run(
    `INSERT INTO session (id,data,time_created,time_updated,role)
     VALUES ('parent','{}',1,1,'resident')`,
  );
  fixture.db.run("UPDATE session SET role='worker',parent_id='parent' WHERE id='legacy'");
  fixture.db.run("UPDATE inbox SET status='consumed',consumed_by='old',consumed_at=2");
  fixture.db.run(
    `INSERT INTO inbox (id,session_id,kind,content,origin,encoding_version,status,time_created,ordinal)
     VALUES ('root-input','parent','prompt','keep','{}',1,'pending',2,1)`,
  );
  const before = fixture.db.query("SELECT rowid,* FROM inbox").all();
  initializeSqliteDatabase(fixture.db);
  expect(fixture.db.query("SELECT rowid,* FROM inbox").all()).toEqual(before);
});

test.each([
  `json_set(data, '$.expectedResponders', json('["alice","alice"]'))`,
  `json_set(data, '$.resolutionPolicy', 'quorum')`,
  `json_set(data, '$.resolutionPolicy', 'quorum', '$.quorum', json('{"expected":2,"threshold":1}'))`,
  `json_set(data, '$.resolutionPolicy', 'quorum', '$.quorum', json('{"expected":1,"threshold":2}'))`,
  `json_set(data, '$.quorum', json('{"expected":1,"threshold":1}'))`,
])("invalid historical responder bounds refuse before cutover: %s", (data) => {
  using fixture = upgradeFixture();
  seedRetiredWait(fixture.db);
  fixture.db.run(`UPDATE wait SET data = ${data}`);
  const before = snapshotDatabase(fixture.db);
  expect(() => initializeSqliteDatabase(fixture.db)).toThrow("wait:retired");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
});

test.each([
  { state: "refused", decidedBy: undefined, decidedAt: undefined },
  { state: "pending", decidedBy: "owner", decidedAt: 2 },
  { state: "approved", decidedBy: "deadline", decidedAt: 2 },
])("dishonest historical consent disposition refuses unchanged: %j", (settlement) => {
  using fixture = upgradeFixture();
  const data = { id: "dishonest", subject: { kind: "contact_promotion", actorId: "peer" },
    requestedBy: "resident", deadline: 10, revision: 1, createdAt: 1, updatedAt: 2, ...settlement };
  fixture.db.run("INSERT INTO approval VALUES ('dishonest',?,1,?,10,1,2)", [JSON.stringify(data), settlement.state]);
  const before = snapshotDatabase(fixture.db);
  expect(() => initializeSqliteDatabase(fixture.db)).toThrow("approval:dishonest");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
});

test.each(["open", "waiting"] as const)("unbound consumed native %s execution refuses even without a pending inbox", (kind) => {
  using fixture = upgradeFixture();
  fixture.db.run("INSERT INTO session (id,data,time_created,time_updated,role) VALUES ('parent','{}',1,1,'resident')");
  fixture.db.run("UPDATE session SET role='worker',parent_id='parent' WHERE id='legacy'");
  fixture.db.run("UPDATE inbox SET status='consumed',consumed_by='old',consumed_at=2");
  fixture.db.run(`INSERT INTO action (id,session_id,kind,intent,effect,irreversible,encoding_version,ts,ordinal)
    VALUES ('native-turn','legacy','turn',?, ?,1,1,2,2)`, [
    JSON.stringify(kind === "open" ? { phase: "intent", resultId: "uncommitted" } : { phase: "terminal", turnId: "old-turn" }),
    JSON.stringify(kind === "open" ? { phase: "pending" } : { phase: "terminal", kind: "waiting" }),
  ]);
  const before = snapshotDatabase(fixture.db);
  const bytes = readFileSync(fixture.path);
  expect(() => initializeSqliteDatabase(fixture.db)).toThrow("turn:native-turn:session:legacy:parent:parent");
  expect(snapshotDatabase(fixture.db)).toEqual(before);
  expect(readFileSync(fixture.path)).toEqual(bytes);
});
