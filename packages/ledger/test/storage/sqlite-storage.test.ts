import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { LedgerSession } from "@openomni/protocol";
import { Migration } from "../../src/storage/migration-runner";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";
import { createDispositionFixture, snapshotDatabase } from "../helpers/disposition-967";

function makeSession(id: string, timeCreated = 1) {
	return {
		id,
		title: `Session ${id}`,
		model: { providerID: "test", modelID: "test-model" },
		time: { created: timeCreated, updated: timeCreated },
		spawnDepth: 0,
	};
}

function canonicalRow(id: string): LedgerSession.Row {
	return LedgerSession.Row.parse({
		id,
		parentId: null,
		role: "resident",
		leaseOwner: null,
		leaseFence: 0,
		leaseExpiresAt: null,
		revision: 0,
		state: "idle",
	});
}

/** Historical schema fixture only, not a retained message/part adapter. */
function seedHistoricalRows(db: Database): void {
	db.exec(`
    INSERT INTO session (id, data, time_created, time_updated) VALUES ('s1', '{}', 1, 1);
    INSERT INTO message (id, session_id, data, role, time_created) VALUES ('m1', 's1', '{"historical":"message"}', 'user', 1);
    INSERT INTO part (id, message_id, data, type, time_start) VALUES ('p1', 'm1', '{"historical":"part"}', 'text', 1);
  `);
}

function applyMigrationFixture(db: Database, name: string): void {
	const migrationPath = join(import.meta.dir, "../../migration", name);
	db.exec(readFileSync(migrationPath, "utf8"));
}

function storageDb(adapter: SqliteStorageAdapter): Database {
	return (adapter as unknown as { db: Database }).db;
}

function tableColumns(db: Database, table: string): string[] {
	return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
		(r) => r.name,
	);
}

function indexNames(db: Database, table: string): string[] {
	return (db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
		(r) => r.name,
	);
}

describe("SqliteStorageAdapter", () => {
	let dbPath = "";
	let adapter: SqliteStorageAdapter;

	beforeEach(() => {
		dbPath = tempDbPath("test-sqlite");
		adapter = new SqliteStorageAdapter(dbPath);
	});

	afterEach(() => {
		adapter.close();
		removeSqliteFiles(dbPath);
	});

	describe("PRAGMA verification", () => {
		test("journal_mode is WAL", () => {
			const db = new Database(dbPath);
			const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
			db.close();
			expect(row.journal_mode).toBe("wal");
		});

		test("foreign_keys are enabled", () => {
			const row = (adapter as unknown as { db: Database }).db
				.query("PRAGMA foreign_keys")
				.get() as { foreign_keys: number };
			expect(row.foreign_keys).toBe(1);
		});
	});

	describe("migration", () => {
		test("all expected tables are created on fresh DB", () => {
			const db = new Database(dbPath);
			const tables = (
				db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
					name: string;
				}>
			).map((r) => r.name);
			db.close();

			expect(tables).toContain("session");
			expect(tables).toContain("message");
			expect(tables).toContain("part");
			expect(tables).toContain("surface_key");
			expect(tables).not.toContain("artifact");
			expect(tables).not.toContain("bus_event");
			expect(tables).toEqual(expect.arrayContaining(["action", "inbox", "alarm", "policy"]));
			expect(tables).toContain("_migrations");
			// Dead tables with no production readers or writers stay absent.
			for (const dead of [
				"event_log",
				"task",
				"task_run",
				"task_idempotency",
				"plan",
				"todo",
				"background_task",
				"cron_job",
				"app_connector_installation",
				"transcript_fact",
			]) {
				expect(tables).not.toContain(dead);
			}
		});

		test("normal boot refuses a partial lifecycle history before the historical drop", () => {
			adapter.close();

			const legacyDb = new Database(dbPath);
			legacyDb
				.query("DELETE FROM _migrations WHERE name = ?")
				.run("0030_drop_retired_tables/migration.sql");
			legacyDb.exec(
				"CREATE TABLE conversation (id TEXT); CREATE TABLE lease (id TEXT); CREATE TABLE engagement (id TEXT);",
			);
			legacyDb.close();

			using upgradedDb = new Database(dbPath);
			const before = snapshotDatabase(upgradedDb);
			expect(() => new SqliteStorageAdapter(dbPath)).toThrow("unsupported_upgrade");
			expect(snapshotDatabase(upgradedDb)).toEqual(before);
			Migration.applyOrdered(upgradedDb, join(import.meta.dir, "../../migration"), [{ name: "0030_drop_retired_tables/migration.sql" }]);
			const retired = upgradedDb
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation', 'lease', 'engagement') ORDER BY name",
				)
				.all()
				.map((row) => row.name);
			expect(retired).toEqual([]);
			expect(
				upgradedDb
					.query<{ name: string }, [string]>("SELECT name FROM _migrations WHERE name = ?")
					.get("0030_drop_retired_tables/migration.sql"),
			).toEqual({ name: "0030_drop_retired_tables/migration.sql" });
		});

		test("observability tables expose the expected columns", () => {
			const db = storageDb(adapter);

			using historical = createDispositionFixture();
			expect(tableColumns(db, "bus_event")).toEqual([]);
			expect(tableColumns(historical.db, "bus_event")).toEqual([
				"id",
				"session_id",
				"run_id",
				"event_type",
				"category",
				"data",
				"trace_id",
				"duration_ms",
				"time_created",
				"prev_hash",
				"event_hash",
				"visibility",
				"payload_status",
				"payload_diagnostic",
			]);
			expect(tableColumns(db, "event_chain")).toEqual([
				"seq",
				"session_id",
				"event_type",
				"event_hash",
				"prev_hash",
				"time_created",
			]);
		});

		test("observability indexes are created", () => {
			const db = storageDb(adapter);

			using historical = createDispositionFixture();
			expect(indexNames(db, "bus_event")).toEqual([]);
			expect(indexNames(historical.db, "bus_event")).toEqual(
				expect.arrayContaining([
					"idx_bus_event_session_time",
					"idx_bus_event_run_time",
					"idx_bus_event_type_session",
					"idx_bus_event_category_session",
					"idx_bus_event_visibility_session",
					"idx_bus_event_trace",
					"idx_bus_event_hash",
				]),
			);
			expect(indexNames(db, "event_chain")).toEqual(
				expect.arrayContaining(["idx_event_chain_session", "idx_event_chain_hash"]),
			);
		});

		test("unsupported boot preserves artifacts before the historical drop is exercised explicitly", () => {
			adapter.close();
			removeSqliteFiles(dbPath);

			const legacyDb = new Database(dbPath);
			applyMigrationFixture(legacyDb, "0001_initial/migration.sql");
			legacyDb
				.query(
					`INSERT INTO artifact (id, session_id, meta, content, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run("legacy-artifact", "legacy-session", "{}", "obsolete", 1, 1);
			legacyDb.close();

			using upgradedDb = new Database(dbPath);
			const before = snapshotDatabase(upgradedDb);
			expect(() => new SqliteStorageAdapter(dbPath)).toThrow("unsupported_upgrade");
			expect(snapshotDatabase(upgradedDb)).toEqual(before);
			Migration.applyOrdered(upgradedDb, join(import.meta.dir, "../../migration"), [{ name: "0030_drop_artifact/migration.sql" }]);
			expect(tableColumns(upgradedDb, "artifact")).toEqual([]);
		});

		test("0031 preserves a valid 0029 session whose agent id is not a role", () => {
			adapter.close();
			removeSqliteFiles(dbPath);
			const legacyDb = new Database(dbPath, { create: true });
			const migrationRoot = join(import.meta.dir, "../../migration");
			const through0029 = readdirSync(migrationRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && /^00(?:0[1-9]|1[0-9]|2[0-9])_/.test(entry.name))
				.map((entry) => ({ name: `${entry.name}/migration.sql` }))
				.sort((left, right) => left.name.localeCompare(right.name));
			Migration.applyOrdered(legacyDb, migrationRoot, through0029);
			const legacy = {
				...makeSession("legacy-agent", 1),
				agent: { id: "agent-1", name: "Research Agent" },
			};
			legacyDb
				.query("INSERT INTO session (id, data, time_created, time_updated) VALUES (?, ?, ?, ?)")
				.run(legacy.id, JSON.stringify(legacy), 1, 1);
			legacyDb.close();

			expect(() => new SqliteStorageAdapter(dbPath)).toThrow("unsupported_upgrade");
			using history = new Database(dbPath);
			const successors = readdirSync(migrationRoot).filter((name) => name.startsWith("00") && name >= "0030").sort().map((name) => ({ name: `${name}/migration.sql` }));
			Migration.applyOrdered(history, migrationRoot, successors);
			const upgraded = new SqliteStorageAdapter(dbPath);
			expect(
				storageDb(upgraded).query("SELECT data FROM session WHERE id = ?").get(legacy.id),
			).toEqual({ data: JSON.stringify(legacy) });
			expect(
				storageDb(upgraded)
					.query("SELECT role, revision, state FROM session WHERE id = ?")
					.get(legacy.id),
			).toEqual({ role: null, revision: 0, state: "idle" });
			expect(upgraded.sessions.list()).toEqual([]);
			upgraded.close();
		});

		test("0031 constraints and fresh/reopen schema-data digest are stable", () => {
			const db = storageDb(adapter);
			const digest = () => ({
				schema: db
					.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
					.all(),
				receipts: db.query("SELECT name FROM _migrations ORDER BY name").all(),
				sessions: db.query("SELECT * FROM session ORDER BY id").all(),
			});
			adapter.sessions.create({
				id: "l0-digest",
				parentId: null,
				role: "resident",
				leaseOwner: null,
				leaseFence: 0,
				leaseExpiresAt: null,
				revision: 0,
				state: "idle",
				toolsGeneration: 0,
				systemHash: "",
				policyGeneration: 0,
			});
			expect(() =>
				db
					.query(
						`INSERT INTO action (
             id, parent_id, session_id, kind, intent, effect, revert, irreversible,
             encoding_version, ts, ordinal
           ) VALUES ('bad', NULL, 'l0-digest', 'invalid', '{}', '{}', NULL, 1, 1, 0, 1)`,
					)
					.run(),
			).toThrow();
			expect(() =>
				db
					.query(
						`INSERT INTO inbox (
             id, session_id, kind, content, origin, encoding_version, status,
             consumed_by, consumed_at, time_created, ordinal
           ) VALUES ('bad', 'l0-digest', 'prompt', '', '{}', 1, 'claimed', NULL, NULL, 0, 1)`,
					)
					.run(),
			).toThrow();
			const before = digest();
			adapter.close();
			const reopened = new SqliteStorageAdapter(dbPath);
			const reopenedDb = storageDb(reopened);
			const after = {
				schema: reopenedDb
					.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
					.all(),
				receipts: reopenedDb.query("SELECT name FROM _migrations ORDER BY name").all(),
				sessions: reopenedDb.query("SELECT * FROM session ORDER BY id").all(),
			};
			expect(after).toEqual(before);
			reopened.close();
		});

		test("failed migration does not leave partially applied schema behind", () => {
			adapter.close();
			removeSqliteFiles(dbPath);

			const db = new Database(dbPath);
			db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)");
			db.exec("CREATE TABLE message (id TEXT PRIMARY KEY)");
			db.close();

			expect(() => new SqliteStorageAdapter(dbPath)).toThrow();

			const checkDb = new Database(dbPath);
			try {
				expect(
					checkDb
						.query("SELECT name FROM _migrations WHERE name = ?")
						.get("0001_initial/migration.sql"),
				).toBeNull();
			} finally {
				checkDb.close();
			}
		});
	});

	describe("FK CASCADE", () => {
		test("deleting session cascades to messages and parts", () => {
			const db = storageDb(adapter);
			seedHistoricalRows(db);
			db.query("DELETE FROM session WHERE id = 's1'").run();
			expect(db.query("SELECT * FROM message").all()).toEqual([]);
			expect(db.query("SELECT * FROM part").all()).toEqual([]);
		});

		test("deleting message cascades to parts", () => {
			const db = storageDb(adapter);
			seedHistoricalRows(db);
			db.query("DELETE FROM message WHERE id = 'm1'").run();
			expect(db.query("SELECT * FROM part").all()).toEqual([]);
		});

		test("deleting session does NOT cascade to surface_key (perimeter domain, #707)", () => {
			// Migration 0019 dropped the surface_key→session FK: the map is a
			// gateway-domain surface (docs/gateway-design.md §4) and a session-row
			// removal may not mutate it behind the gateway's back. The surviving
			// entry converges by brain-side re-materialization on the next Deliver.
			adapter.sessions.create(canonicalRow("s1"));
			adapter.surfaceKey.claim("channel:123", "s1");

			storageDb(adapter).query("DELETE FROM session WHERE id = 's1'").run();

			expect(adapter.surfaceKey?.lookup("channel:123")).toBe("s1");
		});

	});

	describe("surfaceKey", () => {
		beforeEach(() => {
			adapter.sessions.create(canonicalRow("s1"));
			adapter.sessions.create(canonicalRow("s2"));
		});

		test("lookup: returns undefined for unregistered key", () => {
			expect(adapter.surfaceKey?.lookup("channel:999")).toBeUndefined();
		});

		test("claim and lookup", () => {
			adapter.surfaceKey?.claim("channel:123", "s1");
			expect(adapter.surfaceKey?.lookup("channel:123")).toBe("s1");
		});

		test("claim with the current owner as expected reassigns the mapping", () => {
			adapter.surfaceKey?.claim("channel:123", "s1");
			adapter.surfaceKey?.claim("channel:123", "s2", "s1");
			expect(adapter.surfaceKey?.lookup("channel:123")).toBe("s2");
		});
	});

	describe("clear", () => {
		test("clears all data from all tables", () => {
			seedHistoricalRows(storageDb(adapter));
			adapter.surfaceKey?.claim("channel:1", "s1");
			adapter.clear();

			expect(adapter.sessions.list()).toEqual([]);
			expect(storageDb(adapter).query("SELECT * FROM session").all()).toEqual([]);
			expect(storageDb(adapter).query("SELECT * FROM message").all()).toEqual([]);
			expect(storageDb(adapter).query("SELECT * FROM part").all()).toEqual([]);
			expect(adapter.surfaceKey?.lookup("channel:1")).toBeUndefined();
		});
	});

	describe("close", () => {
		test("close() does not throw", () => {
			expect(() => adapter.close()).not.toThrow();
		});

		test("operations after close throw", () => {
			adapter.close();
			expect(() => adapter.sessions.list()).toThrow();
		});
	});

	describe("persistence", () => {
		test("967 frozen message and part bytes survive canonical writes and reopen", () => {
			const db = storageDb(adapter);
			seedHistoricalRows(db);
			const before = {
				sessions: db.query("SELECT * FROM session").all(),
				messages: db.query("SELECT * FROM message").all(),
				parts: db.query("SELECT * FROM part").all(),
			};
			adapter.sessions.create(canonicalRow("live"));
			adapter.close();
			const reopened = new SqliteStorageAdapter(dbPath);
			try {
				const raw = storageDb(reopened);
				expect(raw.query("SELECT * FROM session WHERE id = 's1'").all()).toEqual(before.sessions);
				expect(raw.query("SELECT * FROM message").all()).toEqual(before.messages);
				expect(raw.query("SELECT * FROM part").all()).toEqual(before.parts);
				expect(reopened.sessions.list().map((row) => row.id)).toEqual(["live"]);
			} finally {
				reopened.close();
			}
		});

		test("data survives close and reopen", () => {
			const session = canonicalRow("s1");
			adapter.sessions.create(session);
			adapter.close();

			const adapter2 = new SqliteStorageAdapter(dbPath);
			expect(adapter2.sessions.get("s1")).toEqual(session);
			adapter2.close();
		});
	});
});
