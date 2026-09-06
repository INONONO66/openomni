import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { z } from "zod";
import * as Wait from "../packages/protocol/src/wait/schema";
import { SqliteStorageAdapter } from "../packages/ledger/src/storage/sqlite-storage";
import { inspect967Projections } from "../packages/ledger/src/storage/u967-projection";
import { U967_MIGRATION } from "../packages/ledger/src/storage/u967-preflight";
import { createDispositionFixture, seedRetiredWait, snapshotDatabase } from "../packages/ledger/test/helpers/disposition-967";
import { archiveCli, disposeCli, manifestHash } from "../packages/ledger/test/helpers/disposition-967-cli";
import { fileSha256 } from "./ledger-archive-snapshot";

type Fixture = ReturnType<typeof createDispositionFixture>;

function resultCode(result: ReturnType<typeof archiveCli>): string {
  const line = (result.exitCode === 0 ? result.stdout : result.stderr).split("\n").find((line) => line.startsWith('{"ok":'));
  return z.object({ resultCode: z.string() }).parse(JSON.parse(line ?? "null")).resultCode;
}

function sourceState(fixture: Fixture) {
  return {
    logical: snapshotDatabase(fixture.db),
    mode: fixture.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
    hash: fileSha256(fixture.path),
    markers: fixture.db.query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY rowid").all(),
  };
}

function refusal(fixture: Fixture, flags: readonly string[]) {
  const before = sourceState(fixture);
  const result = archiveCli(fixture, flags);
  const after = sourceState(fixture);
  const observed = { exit: result.exitCode, code: resultCode(result), mode: after.mode,
    logicalUnchanged: isDeepStrictEqual(after.logical, before.logical), bytesUnchanged: after.hash === before.hash,
    markersUnchanged: isDeepStrictEqual(after.markers, before.markers) };
  console.log(JSON.stringify({ refusal: observed, beforeHash: before.hash, afterHash: after.hash }));
  return observed;
}

const literalProbes = [
  ["partial without replies", "UPDATE wait SET partial=1, data=json_set(data,'$.partial',json('true')) WHERE id='retired'"],
  ["duplicate actions", `UPDATE wait SET data=json_set(data,'$.allowedActions', json('["report_result","report_result"]')) WHERE id='retired'`],
  ["impossible reply time", `UPDATE wait SET data=json_set(data,'$.replies', json('[{"replyKey":"r","responderId":"alice","receivedAt":9999999999999}]')) WHERE id='retired'`],
] as const;

const unchanged = { exit: 1, mode: "delete", logicalUnchanged: true, bytesUnchanged: true, markersUnchanged: true };

describe("967 review R2-1 literal CLI eligibility probes", () => {
  for (const owner of ["workItem", "session"] as const) {
    test.each(literalProbes)(`${owner} refuses %s without any source mutation`, (_name, sql) => {
      // Given: the reviewer's cancelled-at-2 fixture and literal SQL, with either owner.
      using fixture = createDispositionFixture();
      seedRetiredWait(fixture.db);
      fixture.db.run("UPDATE wait SET owner_kind=?, data=json_set(data,'$.ownerRef.kind',?) WHERE id='retired'", [owner, owner]);
      fixture.db.run(sql);
      expect(archiveCli(fixture).exitCode).toBe(0);
      const archiveHash = fileSha256(fixture.archive);
      const hash = manifestHash(fixture);
      // When: the actual disposal CLI receives the exact manifest-byte hash.
      const observed = refusal(fixture, ["--dispose-967", "--approve-manifest-sha256", hash]);
      // Then: the whole cutover refuses, including session-only corruption.
      expect(observed).toEqual({ ...unchanged, code: "protected_rows" });
      expect(inspect967Projections(fixture.db, 103).blocked).toContain("invalid_rows");
      expect(fileSha256(fixture.archive)).toBe(archiveHash);
      expect(manifestHash(fixture)).toBe(hash);
      expect(fixture.db.query("SELECT id FROM wait WHERE id='retired'").all()).toEqual([{ id: "retired" }]);
    });
  }

  test.each(["cancelled", "expired", "resolved", "open"] as const)("rejects %s replies before creation or beyond the last update", (status) => {
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db, status);
    for (const at of [0.5, 9999999999999]) {
      fixture.db.run("UPDATE wait SET data=json_set(data,'$.replies',json(?)) WHERE id='retired'",
        [JSON.stringify([{ replyKey: "r", responderId: "alice", receivedAt: at }])]);
      expect(inspect967Projections(fixture.db, 103).blocked).toContain("invalid_rows");
    }
  });

  test.each(["cancelled", "expired", "resolved"] as const)("rejects %s replies outside the terminal window even before updatedAt", (status) => {
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db, status);
    const at = status === "cancelled" ? 2.5 : status === "expired" ? 10 : 103;
    if (status === "expired") fixture.db.run("UPDATE wait SET partial=1,data=json_set(data,'$.partial',json('true')) WHERE id='retired'");
    fixture.db.run(`UPDATE wait SET time_updated=200, data=json_set(data,'$.updatedAt',200,'$.replies',json(?)) WHERE id='retired'`,
      [JSON.stringify([{ replyKey: "r", responderId: "alice", receivedAt: at }])]);
    expect(inspect967Projections(fixture.db, 201).blocked).toContain("invalid_rows");
  });

  for (const policy of ["first_reply", "quorum", "all"] as const) {
    const vectors = policy === "first_reply" ? ["late-only"] as const
      : ["late-only", "threshold-crossing-late", "same-responder-duplicate-early"] as const;
    for (const vector of vectors) {
      test.each(["workItem", "session"] as const)(`${policy} refuses ${vector} resolution for %s`, (owner) => {
        using fixture = createDispositionFixture();
        seedRetiredWait(fixture.db, "resolved");
        const expected = policy === "first_reply" ? ["alice"] : policy === "quorum" ? ["alice", "bob", "carol"] : ["alice", "bob"];
        const replies = [
          { replyKey: "alice", responderId: "alice", receivedAt: vector === "late-only" ? 3 : 2 },
          ...(policy === "first_reply" ? [] : [{ replyKey: "bob", responderId: "bob", receivedAt: 3 }]),
          ...(vector === "same-responder-duplicate-early" ? [{ replyKey: "alice-earlier", responderId: "alice", receivedAt: 1.5 }] : []),
        ];
        fixture.db.run(`UPDATE wait SET owner_kind=?, revision=2, time_updated=3,
          follow_up_until=102, data=json_set(json_remove(data,'$.quorum'),'$.ownerRef.kind',?,'$.revision',2,'$.updatedAt',3,
          '$.resolutionPolicy',?,'$.expectedResponders',json(?),'$.replies',json(?)) WHERE id='retired'`,
          [owner, owner, policy, JSON.stringify(expected), JSON.stringify(replies)]);
        if (policy === "quorum") fixture.db.run("UPDATE wait SET data=json_set(data,'$.quorum',json(?)) WHERE id='retired'",
          [JSON.stringify({ expected: expected.length, threshold: 2 })]);
        // Historical field parsing must succeed; refusal must exercise terminal coherence, not quorum:null.
        const row = fixture.db.query<{ data: string }, []>("SELECT data FROM wait WHERE id='retired'").get();
        if (!row) throw new Error("Expected row with id='retired' not found");
        const historical = z.strictObject({ ...Wait.Record.shape,
          ownerRef: z.strictObject({ kind: z.enum(["session", "workItem"]), id: z.string().min(1) }),
        }).parse(JSON.parse(row.data));
        expect(Object.hasOwn(historical, "quorum")).toBe(policy === "quorum");
        expect(archiveCli(fixture).exitCode).toBe(0);
        const before = sourceState(fixture);
        const archiveHash = fileSha256(fixture.archive);
        const receipt = readFileSync(fixture.manifest);
        const hash = manifestHash(fixture);
        const observed = refusal(fixture, ["--dispose-967", "--approve-manifest-sha256", hash]);
        expect(observed).toEqual({ ...unchanged, code: "protected_rows" });
        expect(inspect967Projections(fixture.db, 103).blocked).toContain("invalid_rows");
        expect(sourceState(fixture)).toEqual(before);
        expect(fileSha256(fixture.archive)).toBe(archiveHash);
        expect(readFileSync(fixture.manifest)).toEqual(receipt);
        expect(manifestHash(fixture)).toBe(hash);
      });
    }
  }

  test.each(["workItem", "session"] as const)("preserves distinct reply keys from the same %s responder with fractional times", (owner) => {
    // Given: valid follow-up replies, including one after resolvedAt, not duplicate reply identities.
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db, "resolved");
    fixture.db.run(`UPDATE wait SET owner_kind=?, revision=2, time_created=1.25, time_updated=2.75, follow_up_until=102.5,
      data=json_set(data,'$.ownerRef.kind',?,'$.revision',2,'$.createdAt',1.25,'$.updatedAt',2.75,'$.resolvedAt',2.5,
      '$.replies',json('[{"replyKey":"r1","responderId":"alice","receivedAt":2.5},{"replyKey":"r2","responderId":"alice","receivedAt":2.75}]')) WHERE id='retired'`, [owner, owner]);
    const before = snapshotDatabase(fixture.db);
    expect(inspect967Projections(fixture.db, 103).blocked).toEqual([]);
    expect(archiveCli(fixture).exitCode).toBe(0);
    const archiveHash = fileSha256(fixture.archive);
    const receipt = readFileSync(fixture.manifest);
    const hash = manifestHash(fixture);
    // When: dispose through the public CLI.
    const disposed = disposeCli(fixture);
    // Then: retire only the retired projection; preserve all session/native protected values.
    expect({ exit: disposed.exitCode, code: resultCode(disposed) }).toEqual({ exit: 0, code: "disposed" });
    const after = snapshotDatabase(fixture.db);
    expect(after.tables.filter(({ name }) => !["bus_event", "wait", "_migrations", "sqlite_sequence"].includes(name)))
      .toEqual(before.tables.filter(({ name }) => !["bus_event", "wait", "_migrations", "sqlite_sequence"].includes(name)));
    expect(after.tables.find(({ name }) => name === "wait")?.rows).toEqual(before.tables.find(({ name }) => name === "wait")?.rows.filter((row) => owner === "session" || row.id !== "retired"));
    expect(fileSha256(fixture.archive)).toBe(archiveHash);
    expect(readFileSync(fixture.manifest)).toEqual(receipt);
    expect(manifestHash(fixture)).toBe(hash);
  });
});

describe("967 review R2-2 same-schema archives", () => {
  test.each(["fresh", "upgraded"] as const)("verifies a newly archived %s 0034 database", (source) => {
    using fixture = createDispositionFixture();
    if (source === "fresh") {
      const adapter = new SqliteStorageAdapter(`${fixture.directory}/fresh.sqlite`);
      adapter.close();
    } else {
      seedRetiredWait(fixture.db);
      expect(archiveCli(fixture).exitCode).toBe(0);
      expect(disposeCli(fixture).exitCode).toBe(0);
    }
    const path = source === "fresh" ? `${fixture.directory}/fresh.sqlite` : fixture.path;
    const current = { ...fixture, path, manifest: `${fixture.directory}/new-manifest.json`, archive: `${fixture.directory}/new-archive.sqlite` };
    using db = new Database(path, { readonly: true, safeIntegers: true });
    const before = snapshotDatabase(db);
    expect(archiveCli(current).exitCode).toBe(0);
    const hash = fileSha256(current.archive);
    // When: literal archive/verify CLI pair uses the newly created archive.
    const verified = archiveCli(current, ["--verify"]);
    // Then: same history is exact equality, not a fabricated migration delta.
    expect({ exit: verified.exitCode, code: resultCode(verified) }).toEqual({ exit: 0, code: "verified" });
    expect(snapshotDatabase(db)).toEqual(before);
    const acknowledged = disposeCli(current);
    expect({ exit: acknowledged.exitCode, code: resultCode(acknowledged) }).toEqual({ exit: 0, code: "already_applied" });
    expect(snapshotDatabase(db)).toEqual(before);
    expect(fileSha256(current.archive)).toBe(hash);
    expect(db.query("SELECT name FROM _migrations WHERE name=?").all(U967_MIGRATION)).toEqual([{ name: U967_MIGRATION }]);
    if (source === "upgraded") {
      const repeated = disposeCli(fixture);
      expect({ exit: repeated.exitCode, code: resultCode(repeated) }).toEqual({ exit: 0, code: "already_applied" });
      expect(archiveCli(fixture, ["--verify"]).exitCode).toBe(0);
      expect(snapshotDatabase(db)).toEqual(before);
    }
  });

  test.each(["missing", "unknown"] as const)("refuses matching but invalid %s migration histories", (fault) => {
    using fixture = createDispositionFixture();
    if (fault === "missing") fixture.db.run("DELETE FROM _migrations WHERE name='0012_wait/migration.sql'");
    else fixture.db.run("INSERT INTO _migrations VALUES ('9999_unknown/migration.sql')");
    expect(archiveCli(fixture).exitCode).toBe(0);
    const observed = refusal(fixture, ["--verify"]);
    expect(observed).toEqual({ ...unchanged, code: "unsupported_upgrade" });
  });
});

describe("967 review R2-3 refusal before writable pragmas", () => {
  test("rechecks the exact receipt under the runner lock before any DELETE", async () => {
    // Given: initial validation succeeds; the native runner signals its held lock.
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db);
    expect(archiveCli(fixture).exitCode).toBe(0);
    const before = snapshotDatabase(fixture.db);
    const hash = fileSha256(fixture.archive);
    const child = Bun.spawn([process.execPath, "--preload", resolve(import.meta.dir, "../packages/ledger/test/helpers/disposition-967-fault.ts"),
      resolve(import.meta.dir, "generate-ledger-archive-manifest.ts"), "--db", fixture.path, "--out", fixture.manifest,
      "--backup", fixture.archive, "--dispose-967", "--approve-manifest-sha256", manifestHash(fixture), "--json"],
    { env: { ...process.env, U967_BOUNDARY: "locked", U967_FAULT_MODE: "lock" }, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const reader = child.stdout.getReader();
    const errors = new Response(child.stderr).text();
    let stdout = "";
    const decoder = new TextDecoder();
    try {
      while (!stdout.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("child exited before migration lock signal");
        stdout += decoder.decode(chunk.value, { stream: true });
      }
      expect(stdout).toContain('"boundary":"locked"');
      // When: approval bytes change after initial validation but before locked revalidation.
      appendFileSync(fixture.manifest, "\n");
      child.stdin.write("1");
      child.stdin.end();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stdout += decoder.decode(chunk.value, { stream: true });
      }
      const exit = await child.exited;
      const stderr = await errors;
      console.log(JSON.stringify({ lockedRevalidation: { exit, stdout, stderr } }));
      // Then: native DELETE signals are absent, rows/schema/markers and archive survive.
      expect(exit).toBe(1);
      expect(stderr).toContain('"resultCode":"digest_mismatch"');
      expect(stdout).not.toContain("after_wait_delete");
      expect(stdout).not.toContain("after_bus_delete");
      expect(snapshotDatabase(fixture.db)).toEqual(before);
      expect(fileSha256(fixture.archive)).toBe(hash);
    } finally {
      reader.releaseLock();
      if (child.exitCode === null) child.kill();
      await child.exited;
      await errors;
    }
  });

  test.each(["missing-manifest", "missing-backup", "wrong-hash", "tampered-manifest", "tampered-backup", "source-drift", "source-identity", "ineligible"] as const)("refuses %s with mode, main bytes, rows, schema and markers unchanged", (fault) => {
    using fixture = createDispositionFixture();
    seedRetiredWait(fixture.db);
    if (fault === "ineligible") fixture.db.run("UPDATE wait SET status='open',revision=0,data=json_remove(json_set(data,'$.status','open','$.revision',0),'$.cancelledAt') WHERE id='retired'");
    expect(archiveCli(fixture).exitCode).toBe(0);
    let hash = manifestHash(fixture);
    if (fault === "missing-manifest") renameSync(fixture.manifest, `${fixture.manifest}.retained`);
    if (fault === "missing-backup") renameSync(fixture.archive, `${fixture.archive}.retained`);
    if (fault === "tampered-manifest") appendFileSync(fixture.manifest, "\n");
    if (fault === "tampered-backup") appendFileSync(fixture.archive, "x");
    if (fault === "source-drift") fixture.db.run("UPDATE message SET data='changed'");
    if (fault === "source-identity") {
      const receipt = z.object({ source: z.object({ inode: z.string() }) }).parse(JSON.parse(readFileSync(fixture.manifest, "utf8")));
      // Keep valid JSON and recompute approval so identity, not confirmation, is tested.
      const text = readFileSync(fixture.manifest, "utf8").replace(`"inode": "${receipt.source.inode}"`, '"inode": "0"');
      writeFileSync(fixture.manifest, text);
      hash = manifestHash(fixture);
    }
    const archivePath = existsSync(fixture.archive) ? fixture.archive : `${fixture.archive}.retained`;
    const archiveHash = fileSha256(archivePath);
    // When: actual command uses a missing artifact or invalid exact approval/source.
    const observed = refusal(fixture, ["--dispose-967", "--approve-manifest-sha256", fault === "wrong-hash" ? "0".repeat(64) : hash]);
    // Then: even writable connection setup has made no source mutation.
    const code = fault.startsWith("missing-") ? "archive_missing" : fault === "source-drift" ? "stale_archive:message"
      : fault === "source-identity" ? "unsafe_path" : fault === "ineligible" ? "protected_rows" : "digest_mismatch";
    expect(observed).toEqual({ ...unchanged, code });
    expect(fileSha256(archivePath)).toBe(archiveHash);
  });
});
