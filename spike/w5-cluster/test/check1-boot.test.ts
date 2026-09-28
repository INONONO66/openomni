import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { GENESIS_PREV_HASH } from "../../../packages/ledger/src/storage/l0-hash";
import { makeRuntime } from "../src/runtime.ts";
import { sendPrompt } from "../src/session-entity.ts";
import { fileFor, readChain } from "../src/session-file.ts";

const dir = mkdtempSync(join(tmpdir(), "w5-check1-"));
const root = join(dir, "sessions");
mkdirSync(root, { recursive: true });
const catalogFile = join(dir, "catalog.sqlite");

const runtime = ManagedRuntime.make(makeRuntime({ root, catalogFile }));

afterAll(async () => {
  await runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** Await a DB predicate (a row appearing) with a bounded timeout; no bare sleeps. */
async function waitForDbRow(label: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for DB row: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a: runtime boots and cluster_* tables exist in the catalog file", async () => {
  await runtime.runPromise(Effect.void);
  const db = new Database(catalogFile, { readonly: true });
  try {
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cluster_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual([
      "cluster_locks",
      "cluster_messages",
      "cluster_migrations",
      "cluster_replies",
      "cluster_runners",
    ]);
  } finally {
    db.close();
  }
});

test("b: prompts append to OUR hash chain (ordinal 1 then 2, linked prev_hash)", async () => {
  const first = await runtime.runPromise(sendPrompt("s1", "hello"));
  expect(first.ordinal).toBe(1);
  expect(first.actionHash).toMatch(/^[0-9a-f]{64}$/);

  const second = await runtime.runPromise(sendPrompt("s1", "hello again"));
  expect(second.ordinal).toBe(2);
  expect(second.actionHash).toMatch(/^[0-9a-f]{64}$/);
  expect(second.actionHash).not.toBe(first.actionHash);

  const db = new Database(fileFor(root, "s1"), { readonly: true });
  try {
    const chain = readChain(db, "s1");
    expect(chain.length).toBe(2);
    expect(chain[0]?.ordinal).toBe(1);
    expect(chain[0]?.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(chain[0]?.action_hash).toBe(first.actionHash);
    expect(chain[1]?.ordinal).toBe(2);
    expect(chain[1]?.prev_hash).toBe(first.actionHash);
    expect(chain[1]?.action_hash).toBe(second.actionHash);
  } finally {
    db.close();
  }
});

test("c: cluster_messages holds processed rows for the Session entity", async () => {
  const countProcessed = (): number => {
    const db = new Database(catalogFile, { readonly: true });
    try {
      const row = db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM cluster_messages WHERE entity_type = 'Session' AND processed = 1",
        )
        .get();
      return row?.n ?? 0;
    } finally {
      db.close();
    }
  };
  await waitForDbRow("processed Session message in cluster_messages", () => countProcessed() >= 1);
  expect(countProcessed()).toBeGreaterThanOrEqual(1);
});

test("d: per-session files: s1 exists, s2 gets its own file", async () => {
  expect(existsSync(fileFor(root, "s1"))).toBe(true);

  const reply = await runtime.runPromise(sendPrompt("s2", "own file"));
  expect(reply.ordinal).toBe(1);
  expect(existsSync(fileFor(root, "s2"))).toBe(true);
  expect(fileFor(root, "s2")).not.toBe(fileFor(root, "s1"));

  const db = new Database(fileFor(root, "s2"), { readonly: true });
  try {
    const chain = readChain(db, "s2");
    expect(chain.length).toBe(1);
    expect(chain[0]?.prev_hash).toBe(GENESIS_PREV_HASH);
  } finally {
    db.close();
  }
});
