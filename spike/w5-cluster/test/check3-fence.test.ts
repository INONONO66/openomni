/**
 * Check 3: two OS processes opening the same per-session sqlite file cannot
 * both write the session. OUR commit fence (lease_owner + lease_fence + CAS
 * revision in commitSession) refuses the loser with reason "stale" while the
 * holder's commit succeeds — plus the raw SQLite-level fact that a held
 * BEGIN IMMEDIATE makes a second writer fail with SQLITE_BUSY after
 * busy_timeout (5000ms, set by the ledger's connection pragmas).
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GENESIS_PREV_HASH } from "../../../packages/ledger/src/storage/l0-hash";
import { ensureSessionRow, openSessionDb, readChain } from "../src/session-file.ts";

const dir = mkdtempSync(join(tmpdir(), "w5-check3-"));
const sessionId = "s-fence";
const file = join(dir, `${sessionId}.sqlite`);
const childPath = new URL("../src/fence-child.ts", import.meta.url).pathname;

// Bootstrap: schema + session row owned by A at fence 1, revision 0.
{
  const db = openSessionDb(file);
  ensureSessionRow(db, sessionId, "A", 1);
  db.close();
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ChildResult = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  revision: z.number().optional(),
});
type ChildResult = z.infer<typeof ChildResult>;

async function spawnWriter(
  owner: string,
  fence: number,
  expectedRevision: number,
): Promise<ChildResult> {
  const proc = Bun.spawn(
    [process.execPath, childPath, file, sessionId, owner, String(fence), String(expectedRevision)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`fence-child exited ${exitCode}: ${stderr}`);
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) throw new Error(`fence-child printed no JSON (stderr: ${stderr})`);
  return ChildResult.parse(JSON.parse(last));
}

test("a: holder A (fence 1, rev 0) commits -> revision 1", async () => {
  const result = await spawnWriter("A", 1, 0);
  expect(result).toEqual({ ok: true, revision: 1 });
});

test("b: second writer B (fence 2, rev 1) is refused with reason 'stale'", async () => {
  const result = await spawnWriter("B", 2, 1);
  expect(result).toEqual({ ok: false, reason: "stale" });
});

test("c: holder A commits again (rev 1) -> revision 2", async () => {
  const result = await spawnWriter("A", 1, 1);
  expect(result).toEqual({ ok: true, revision: 2 });
});

test("d: CONCURRENT A and B from revision 2 -> exactly one succeeds (A), B 'stale'; chain has 3 linked rows", async () => {
  const [a, b] = await Promise.all([spawnWriter("A", 1, 2), spawnWriter("B", 2, 2)]);
  expect(a).toEqual({ ok: true, revision: 3 });
  expect(b).toEqual({ ok: false, reason: "stale" });
  expect([a, b].filter((result) => result.ok).length).toBe(1);

  const db = new Database(file, { readonly: true });
  try {
    const chain = readChain(db, sessionId);
    expect(chain.length).toBe(3);
    expect(chain[0]?.ordinal).toBe(1);
    expect(chain[0]?.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(chain[1]?.ordinal).toBe(2);
    expect(chain[1]?.prev_hash).toBe(chain[0]?.action_hash);
    expect(chain[2]?.ordinal).toBe(3);
    expect(chain[2]?.prev_hash).toBe(chain[1]?.action_hash);
    for (const row of chain) expect(row.action_hash).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    db.close();
  }
});

/** Read a spawned process's stdout until `token` appears; bounded timeout, no bare sleeps. */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  token: string,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (!text.includes(token)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for "${token}" (got: ${text})`);
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timed out waiting for "${token}"`)), remaining);
      }),
    ]);
    if (chunk.done) throw new Error(`stream ended before "${token}" (got: ${text})`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

// The clock IS the thing under test here: SQLite's busy_timeout (5000ms per
// the ledger connection pragmas) must expire and surface SQLITE_BUSY.
test("e: SQLite-level: held BEGIN IMMEDIATE makes the second writer fail SQLITE_BUSY after busy_timeout", async () => {
  const holderCode = [
    'const { Database } = require("bun:sqlite");',
    "const db = new Database(process.env.W5_CHECK3_FILE);",
    'db.exec("BEGIN IMMEDIATE");',
    'console.log("HOLDING");',
    'process.stdin.on("data", () => { db.exec("COMMIT"); db.close(); process.exit(0); });',
  ].join("\n");
  const holder = Bun.spawn([process.execPath, "-e", holderCode], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, W5_CHECK3_FILE: file },
  });
  try {
    await readUntil(holder.stdout, "HOLDING", 10_000);

    // Correct owner/fence/revision: only the OS-level write lock blocks it.
    const started = Date.now();
    const result = await spawnWriter("A", 1, 3);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SQLITE_BUSY|database is locked/i);
    // busy_timeout is 5000ms; the writer must have waited it out, not failed instantly.
    expect(elapsedMs).toBeGreaterThanOrEqual(4000);
    console.log(
      `check3(e): observed second-writer error after ${elapsedMs}ms: ${JSON.stringify(result.reason)}`,
    );
  } finally {
    holder.stdin.write("release\n");
    await holder.stdin.end();
    await holder.exited;
  }

  // With the lock released, the same fenced write commits -> revision 4.
  const after = await spawnWriter("A", 1, 3);
  expect(after).toEqual({ ok: true, revision: 4 });
});
