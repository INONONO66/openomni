import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engagement, Wait } from "@openomni/protocol";
import { DelegationStore } from "../../src/delegation/index.js";
import { EngagementStore } from "../../src/engagement/index.js";
import { Migration } from "../../src/storage/migration-runner.js";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage.js";
import { Storage } from "../../src/storage/storage.js";
import { WaitStore } from "../../src/wait/index.js";
import { buildDelegationRecord } from "../helpers/delegation.js";
import { buildWaitCreate } from "../helpers/wait.js";

const directories: string[] = [];
let adapter: SqliteStorageAdapter;

function database(): Database {
  return (adapter as unknown as { db: Database }).db;
}

beforeEach(() => {
  Storage.reset();
  adapter = new SqliteStorageAdapter(":memory:");
  Storage.configure(adapter);
});

afterEach(() => {
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite adapter contract guards", () => {
  test("delegation reads reject a row whose key disagrees with its payload", () => {
    const record = DelegationStore.create(buildDelegationRecord());
    database()
      .query("UPDATE delegation SET data = ? WHERE delegation_id = ?")
      .run(JSON.stringify({ ...record, delegationId: "delegation-foreign" }), record.delegationId);

    expect(() => DelegationStore.get(record.delegationId)).toThrow("Delegation id mismatch");
  });

  test("engagement compare-and-set enforces key and one-step revision", () => {
    const record = EngagementStore.open(
      {
        id: "eng-adapter-guard",
        ownerSessionId: "session-owner",
        title: "adapter guard",
        terms: {},
      },
      "trace-adapter",
      100,
    );
    const subAdapter = adapter.engagement;
    if (!subAdapter) throw new Error("engagement adapter missing");
    const next = Engagement.Record.parse({ ...record, revision: record.revision + 1, updatedAt: 101 });

    expect(() => subAdapter.compareAndSet("eng-foreign", record.revision, next)).toThrow(
      "Engagement id mismatch",
    );
    expect(() =>
      subAdapter.compareAndSet(record.id, record.revision, { ...next, revision: record.revision + 2 }),
    ).toThrow("Engagement revision must advance exactly once");
  });

  test("wait correlation and compare-and-set fail closed on malformed calls", () => {
    const record = WaitStore.create(buildWaitCreate(), "trace-adapter");
    const subAdapter = adapter.wait;
    if (!subAdapter) throw new Error("wait adapter missing");
    const next = Wait.Record.parse({ ...record, revision: record.revision + 1, updatedAt: 101 });

    expect(() => subAdapter.findByCorrelation({})).toThrow(
      "Wait correlation query must carry at least one correlation field",
    );
    expect(() => subAdapter.compareAndSet("wait-foreign", record.revision, next)).toThrow(
      "Wait id mismatch",
    );
    expect(() =>
      subAdapter.compareAndSet(record.id, record.revision, { ...next, revision: record.revision + 2 }),
    ).toThrow("Wait revision must advance exactly once");
  });

  test("session parse cache evicts its oldest normalized snapshot at capacity", () => {
    for (let index = 0; index <= 4096; index += 1) {
      const id = `session-cache-${index}`;
      adapter.session.set(id, {
        id,
        title: id,
        model: { providerID: "test", modelID: "test" },
        time: { created: index, updated: index },
        spawnDepth: 0,
      });
      expect(adapter.session.get(id)?.id).toBe(id);
    }
    expect(adapter.session.get("session-cache-0")?.id).toBe("session-cache-0");
  });
});

describe("migration rollback preservation", () => {
  test("preserves the migration failure when rollback itself fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-migration-rollback-"));
    directories.push(directory);
    writeFileSync(join(directory, "broken.sql"), "CREATE TABLE broken (id TEXT)");
    const migrationFailure = new Error("migration statement failed");
    const calls: string[] = [];
    const fake = {
      exec(sql: string) {
        calls.push(sql);
        if (sql === "ROLLBACK") throw new Error("rollback failed");
      },
      query(sql: string) {
        return {
          get: () => null,
          run: () => {
            if (sql.startsWith("INSERT INTO _migrations")) return undefined;
            throw migrationFailure;
          },
        };
      },
      run() {
        throw migrationFailure;
      },
    } as unknown as Database;

    expect(() => Migration.applyOrdered(fake, directory, [{ name: "broken.sql" }])).toThrow(
      migrationFailure,
    );
    expect(calls.at(-1)).toBe("ROLLBACK");
  });
});
