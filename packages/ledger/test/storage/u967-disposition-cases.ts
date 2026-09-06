import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDispositionFixture, seedRetiredWait, snapshotDatabase } from "../helpers/disposition-967";
import { archiveAndVerify, disposeCli, manifestHash } from "../helpers/disposition-967-cli";
import { inspect967Projections } from "../../src/storage/u967-projection";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";

function faultCommand(fixture: ReturnType<typeof createDispositionFixture>) {
	return [process.execPath, "--preload", resolve(import.meta.dir, "../helpers/disposition-967-fault.ts"),
	resolve(import.meta.dir, "../../../../script/generate-ledger-archive-manifest.ts"),
		"--db", fixture.path, "--out", fixture.manifest, "--backup", fixture.archive, "--json",
		"--dispose-967", "--approve-manifest-sha256", manifestHash(fixture)];
}

const boundaries = ["after_wait_delete", "after_bus_delete", "after_guard", "after_drop", "after_marker", "before_commit", "after_commit"] as const;

describe("967 WAL rollback crash and resumability", () => {
	for (const mode of ["throw", "crash"] as const) {
		test.each([...boundaries])(`${mode} at %s preserves the atomic boundary and archive`, (boundary) => {
			using fixture = createDispositionFixture();
			seedRetiredWait(fixture.db);
			archiveAndVerify(fixture);
			const before = snapshotDatabase(fixture.db);
			const archive = readFileSync(fixture.archive);
			const result = Bun.spawnSync(faultCommand(fixture), {
				env: { ...process.env, U967_BOUNDARY: boundary, U967_FAULT_MODE: mode }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
			});
			console.log(JSON.stringify({
				mode, boundary, exit: result.exitCode, signal: result.signalCode,
				stdout: result.stdout.toString(), stderr: result.stderr.toString()
			}));
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout.toString()).toContain(`"boundary":"${boundary}"`);
			if (boundary !== "after_commit") expect(snapshotDatabase(fixture.db)).toEqual(before);
			else expect(fixture.db.query("SELECT name FROM sqlite_master WHERE name = 'bus_event'").all()).toEqual([]);
			expect(readFileSync(fixture.archive)).toEqual(archive);
			const resumed = disposeCli(fixture);
			expect(resumed.exitCode).toBe(0);
			if (boundary === "after_commit") expect(resumed.stdout).toContain('"resultCode":"already_applied"');
			expect(fixture.db.query("SELECT count(*) AS n FROM _migrations WHERE name LIKE '0034%'").get()).toEqual({ n: 1n });
			for (let reopen = 0; reopen < 2; reopen += 1) {
				const adapter = new SqliteStorageAdapter(fixture.path);
				adapter.close();
			}
		});
	}

	test("surfaces a rollback failure and closes before raw inspection and retry", () => {
		using fixture = createDispositionFixture();
		seedRetiredWait(fixture.db);
		archiveAndVerify(fixture);
		const before = snapshotDatabase(fixture.db);
		const result = Bun.spawnSync(faultCommand(fixture), {
			env: { ...process.env, U967_BOUNDARY: "after_wait_delete", U967_FAULT_MODE: "rollback-failure" }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
		});
		console.log(JSON.stringify({ rollbackFailure: result.stderr.toString(), exit: result.exitCode }));
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("injected_rollback_failure");
		expect(snapshotDatabase(fixture.db)).toEqual(before);
		expect(disposeCli(fixture).exitCode).toBe(0);
	});

	test("a contender triggered by the exact in-transaction lock signal cannot write", async () => {
		using fixture = createDispositionFixture();
		seedRetiredWait(fixture.db);
		archiveAndVerify(fixture);
		const child = Bun.spawn(faultCommand(fixture), {
			env: { ...process.env, U967_BOUNDARY: "locked", U967_FAULT_MODE: "lock" }, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000,
		});
		const reader = child.stdout.getReader();
		try {
			let signal = "";
			const decoder = new TextDecoder();
			while (!signal.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("disposal exited without lock signal");
				signal += decoder.decode(chunk.value, { stream: true });
			}
			expect(signal).toContain('"boundary":"locked"');
			const writer = Bun.spawnSync([process.execPath, "-e",
				'import {Database} from "bun:sqlite"; using db=new Database(process.argv[1]); db.run("PRAGMA busy_timeout=0"); db.run("BEGIN IMMEDIATE"); db.run("ROLLBACK");', fixture.path],
				{ stdout: "pipe", stderr: "pipe", timeout: 5_000 });
			console.log(JSON.stringify({ signal, contenderExit: writer.exitCode, contenderError: writer.stderr.toString() }));
			expect(writer.exitCode).toBe(1);
			expect(writer.stderr.toString()).toContain("database is locked");
			const errors = new Response(child.stderr).text();
			child.stdin.write("1");
			child.stdin.end();
			for (; ;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				signal += decoder.decode(chunk.value, { stream: true });
			}
			expect(await child.exited).toBe(0);
			console.log(JSON.stringify({ exit: child.exitCode, stdout: signal, stderr: await errors }));
		} finally {
			reader.releaseLock();
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
	});
});

describe("967 atomic disposition eligibility", () => {
	test("refuses an incomplete resolved quorum", () => {
		using fixture = createDispositionFixture();
		seedRetiredWait(fixture.db, "resolved");
		fixture.db.run(`UPDATE wait SET data = json_set(data, '$.expectedResponders', json('["alice","bob"]'),
      '$.resolutionPolicy', 'quorum', '$.quorum', json('{"expected":2,"threshold":2}')) WHERE id = 'retired'`);
		archiveAndVerify(fixture);
		const before = snapshotDatabase(fixture.db);
		expect(disposeCli(fixture).exitCode).toBe(1);
		expect(snapshotDatabase(fixture.db)).toEqual(before);
	});

	test.each([101, 102, 103])("resolved follow-up is inclusive at injected time %d", (at) => {
		using fixture = createDispositionFixture();
		seedRetiredWait(fixture.db, "resolved");
		const inspected = inspect967Projections(fixture.db, at);
		expect(inspected.candidates.length).toBe(at > 102 ? 1 : 0);
		expect(inspected.blocked.length).toBe(at > 102 ? 0 : 1);
	});

});
