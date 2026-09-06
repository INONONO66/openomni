import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { createSqliteReplyGrantAdapter } from "../../src/storage/sqlite-reply-grant-adapter";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";

const grant = {
	id: "grant-1", ruleId: "rule-1", senderId: "persona", targetActorId: "guest",
	operations: ["fire_and_forget" as const],
	replyScope: { surfaceKey: "telegram:chat-1" }, expiresAt: 100,
};

describe("durable reply-grant current projection", () => {
	test("independent connections racing for one slot admit exactly one grant", async () => {
		const directory = mkdtempSync(join(tmpdir(), "reply-grant-race-"));
		const path = join(directory, "ledger.sqlite");
		const adapter = new SqliteStorageAdapter(path);
		const gate = new SharedArrayBuffer(4);
		const workers: Worker[] = [];
		try {
			const signal = AbortSignal.timeout(10_000);
			// Race grant claims, not connection startup/WAL recovery. Keep the
			// initialized database open and await each worker's exact ready signal.
			for (const id of ["guest-1", "guest-2"]) {
				const worker = new Worker(new URL("../helpers/reply-grant-race-worker.ts", import.meta.url), {
					workerData: { path, id, gate },
				});
				workers.push(worker);
				expect(await once(worker, "message", { signal })).toEqual(["ready"]);
			}
			const results = workers.map((worker) => once(worker, "message", { signal }));

			Atomics.store(new Int32Array(gate), 0, 1);
			Atomics.notify(new Int32Array(gate), 0);

			expect((await Promise.all(results)).flat().sort()).toEqual(["capacity", "claimed"]);
			const reopened = new SqliteStorageAdapter(path);
			try {
				expect(reopened.replyGrant.listLive(1)).toHaveLength(1);
			} finally {
				reopened.close();
			}
		} finally {
			await Promise.all(workers.map((worker) => worker.terminate()));
			adapter.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a failed insert rolls expiry pruning back and never projects the failed grant", () => {
		using db = new Database(":memory:");
		initializeSqliteDatabase(db);
		const store = createSqliteReplyGrantAdapter(db);
		store.claim(grant, { at: 1, maxLiveInstances: 1 });
		db.run("CREATE TRIGGER reject_reply BEFORE INSERT ON reply_grant BEGIN SELECT RAISE(ABORT, 'projection_failure'); END");

		expect(() => store.claim({ ...grant, id: "failed", expiresAt: 200 }, {
			at: 101, maxLiveInstances: 1,
		})).toThrow("projection_failure");

		expect(store.listLive(1)).toEqual([grant]);
		expect(store.listLive(101)).toEqual([]);
	});

	test("live queries use the expiry index and exclude expired or malformed historical payloads", () => {
		using db = new Database(":memory:");
		initializeSqliteDatabase(db);
		const store = createSqliteReplyGrantAdapter(db);
		store.claim(grant, { at: 1, maxLiveInstances: 1 });
		db.run("INSERT INTO reply_grant VALUES ('old', '{', 'old-rule', 'old-guest', 'old-surface', 0)");

		const live = store.listLive(1);

		expect(live).toEqual([grant]);
		const plan = db.query<{ detail: string }, []>(
			"EXPLAIN QUERY PLAN SELECT data FROM reply_grant WHERE expires_at >= 1",
		).all();
		expect(plan.some(({ detail }) => detail.includes("SEARCH reply_grant USING INDEX idx_reply_grant_expiry"))).toBe(true);
		expect(db.query("SELECT data FROM reply_grant WHERE id = 'old'").get()).toEqual({ data: "{" });
	});

	test("malformed live rows fail closed at the persisted-data boundary", () => {
		using db = new Database(":memory:");
		initializeSqliteDatabase(db);
		const store = createSqliteReplyGrantAdapter(db);
		db.run("INSERT INTO reply_grant VALUES ('bad', '{', 'rule-1', 'guest', 'telegram:chat-1', 100)");

		expect(() => store.listLive(1)).toThrow(SyntaxError);
	});

	test.each([
		"UPDATE reply_grant SET data = json_remove(data, '$.ruleId', '$.replyScope')",
		"UPDATE reply_grant SET data = json_set(data, '$.expiresAt', 200)",
		"UPDATE reply_grant SET data = json_set(data, '$.replyScope.surfaceKey', 'telegram:elsewhere')",
	])("incoherent indexed authority fails closed: %s", (sql) => {
		using db = new Database(":memory:");
		initializeSqliteDatabase(db);
		const store = createSqliteReplyGrantAdapter(db);
		store.claim(grant, { at: 1, maxLiveInstances: 1 });
		db.run(sql);

		expect(() => store.listLive(1)).toThrow(expect.objectContaining({
			code: "incoherent_reply_grant", grantId: grant.id,
		}));
	});

	test("repeat contact preserves expiry while a later first contact reuses expired capacity", () => {
		using db = new Database(":memory:");
		initializeSqliteDatabase(db);
		const store = createSqliteReplyGrantAdapter(db);
		expect(store.claim(grant, { at: 1, maxLiveInstances: 1 })).toBe("claimed");
		expect(store.claim({ ...grant, id: "retry", expiresAt: 200 }, {
			at: 100, maxLiveInstances: 1,
		})).toBe("existing");
		expect(store.listLive(100)).toEqual([grant]);

		expect(store.claim({ ...grant, id: "later", expiresAt: 200 }, {
			at: 101, maxLiveInstances: 1,
		})).toBe("claimed");

		expect(store.listLive(101)).toEqual([{ ...grant, id: "later", expiresAt: 200 }]);
	});
});
