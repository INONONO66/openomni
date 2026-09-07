import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { PlainValue } from "@openomni/protocol";
import { LedgerSession } from "@openomni/protocol";
import { createSqliteL0Adapters } from "../../src/storage/sqlite-l0-adapter";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";
import { sqliteSchema } from "../../src/storage/u967-preflight";

const command = { command: "printf READY", description: "valid", persistent: true };
const valid = { watch: command, policyGeneration: 1, notificationLimit: 8 };
const malformed: readonly [string, PlainValue][] = [
  ["empty watch", { watch: {} }],
  ["missing source", { ...valid, watch: { description: "missing", persistent: true } }],
  ["missing lifetime", { ...valid, watch: { command: "true", description: "missing" } }],
  ["missing generation", { watch: command, notificationLimit: 8 }],
  ["missing budget", { watch: command, policyGeneration: 1 }],
  ["zero budget", { ...valid, notificationLimit: 0 }],
  ["fractional generation", { ...valid, policyGeneration: 1.5 }],
  ["two lifetimes", { ...valid, watch: { ...command, timeout_ms: 50 } }],
  ["false persistent", { ...valid, watch: { ...command, persistent: false } }],
  [
    "invalid timeout",
    { ...valid, watch: { command: "true", description: "negative", timeout_ms: -1 } },
  ],
  ["unsupported spec key", { ...valid, surprise: true }],
  ["unsupported source key", { ...valid, watch: { ...command, extra: true } }],
  ["two sources", { ...valid, watch: { ...command, path: "/tmp/ready", event: "create" } }],
  [
    "relative path",
    {
      ...valid,
      watch: { path: "ready", event: "create", description: "relative", persistent: true },
    },
  ],
  [
    "unsupported event",
    {
      ...valid,
      watch: { path: "/tmp/ready", event: "delete", description: "event", persistent: true },
    },
  ],
  ["invalid regex", { ...valid, watch: { ...command, filter: "[" } }],
  ["empty command", { ...valid, watch: { ...command, command: "" } }],
];

function historical(spec: PlainValue) {
  const db = new Database(":memory:");
  // The frozen archive boundary creates the actual pre-watch schema, not a fake.
  initializeSqliteDatabase(db, () => undefined);
  const adapter = createSqliteL0Adapters(db, (operation) => db.transaction(operation).immediate(), {
    publish: () => undefined,
  });
  adapter.sessions.create(
    LedgerSession.Row.parse({
      id: "legacy",
      parentId: null,
      role: "resident",
      state: "idle",
      revision: 0,
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
    }),
  );
  adapter.alarms.arm({
    id: "legacy-watch",
    sessionId: "legacy",
    kind: "watch",
    fireAt: 1000,
    spec: { encodingVersion: 1, value: spec },
  });
  return db;
}

for (const [name, spec] of malformed) {
  test(`0035 refuses ${name} before changing the old database`, () => {
    using db = historical(spec);
    const before = db.serialize();
    const schema = sqliteSchema(db);
    expect(() => initializeSqliteDatabase(db)).toThrow("legacy-watch");
    expect(db.serialize()).toEqual(before);
    expect(sqliteSchema(db)).toEqual(schema);
    expect(
      db
        .query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1")
        .get()?.name,
    ).toBe("0034_u967_archive_disposition/migration.sql");
  });
}

for (const [name, spec] of [
  ["command", valid],
  [
    "path",
    {
      ...valid,
      watch: { path: "/tmp/ready", event: "modify", description: "valid path", timeout_ms: 50 },
    },
  ],
] satisfies [string, PlainValue][]) {
  test(`0035 upgrades a complete ${name} spec without losing bytes`, () => {
    using db = historical(spec);
    const before = db.query<{ spec: string }, []>("SELECT spec FROM alarm").get();
    initializeSqliteDatabase(db);
    expect(db.query<{ spec: string }, []>("SELECT spec FROM alarm").get()).toEqual(before);
    expect(
      db.query<{ epoch: number; fence: number }, []>("SELECT epoch, fence FROM alarm").get(),
    ).toEqual({ epoch: 1, fence: 0 });
    initializeSqliteDatabase(db); // The guarded migration is forward-only and idempotent.
  });
}
