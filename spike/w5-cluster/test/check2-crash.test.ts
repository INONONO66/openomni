import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENESIS_PREV_HASH } from "../../../packages/ledger/src/storage/l0-hash";
import { fileFor } from "../src/session-file.ts";

const dir = mkdtempSync(join(tmpdir(), "w5-check2-"));
const root = join(dir, "sessions");
mkdirSync(root, { recursive: true });
const catalogFile = join(dir, "catalog.sqlite");
const sessionId = "s-crash";
const childScript = join(import.meta.dir, "..", "src", "crash-child.ts");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface MessageRow {
  readonly id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly tag: string;
  readonly processed: number;
  readonly deliver_at: number | null;
}

function messageRows(): MessageRow[] {
  const db = new Database(catalogFile, { readonly: true });
  try {
    return db
      .query<MessageRow, []>(
        "SELECT CAST(id AS TEXT) AS id, entity_type, entity_id, tag, processed, deliver_at FROM cluster_messages ORDER BY rowid ASC",
      )
      .all();
  } finally {
    db.close();
  }
}

function actionCount(): number {
  const db = new Database(fileFor(root, sessionId), { readonly: true });
  try {
    const row = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM action WHERE session_id = ?")
      .get(sessionId);
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

/** Accumulate a child's stdout until `pattern` matches; bounded, no bare sleeps. */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; got:\n${text}`)), timeoutMs);
  });
  try {
    while (!pattern.test(text)) {
      const chunk = await Promise.race([reader.read(), timer]);
      if (chunk.done) throw new Error(`stream ended before ${pattern}; got:\n${text}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}

function spawnChild(mode: "crash" | "restart") {
  return Bun.spawn({
    cmd: [
      process.execPath,
      "--tsconfig-override=tsconfig.child.json",
      childScript,
      root,
      catalogFile,
      sessionId,
      mode,
    ],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("check2: SIGKILL mid-turn loses nothing; redelivery dedupes; DeliverAt honors residual", async () => {
  // ---- phase 1: crash ------------------------------------------------------
  const crash = spawnChild("crash");
  const crashOut = await readUntil(crash.stdout, /APPENDED 1 /, 30_000);
  process.kill(crash.pid, "SIGKILL");
  const crashExit = await crash.exited;
  console.log(`[check2] crash pid=${crash.pid} exit=${crashExit}\n${crashOut.trimEnd()}`);
  expect(crashOut).toMatch(/APPENDED 1 turn=turn-1 deduped=false action_hash=[0-9a-f]{64}/);

  // Action 1 committed durably before the kill.
  expect(actionCount()).toBe(1);
  {
    const db = new Database(fileFor(root, sessionId), { readonly: true });
    try {
      const row = db
        .query<{ ordinal: number; prev_hash: string }, [string]>(
          "SELECT ordinal, prev_hash FROM action WHERE session_id = ? AND id = 'turn-1'",
        )
        .get(sessionId);
      expect(row?.ordinal).toBe(1);
      expect(row?.prev_hash).toBe(GENESIS_PREV_HASH);
    } finally {
      db.close();
    }
  }

  // The mailbox row survived the SIGKILL unprocessed (real column: processed).
  const afterCrash = messageRows().filter((row) => row.entity_type === "CrashSession");
  console.log(`[check2] cluster_messages after crash: ${JSON.stringify(afterCrash)}`);
  expect(afterCrash.length).toBe(1);
  expect(Number(afterCrash[0]?.processed)).toBe(0);
  expect(afterCrash[0]?.tag).toBe("Turn");

  // ---- phase 2: restart ----------------------------------------------------
  const restart = spawnChild("restart");
  const [out, err, exit] = await Promise.all([
    new Response(restart.stdout).text(),
    new Response(restart.stderr).text(),
    restart.exited,
  ]);
  console.log(`[check2] restart pid=${restart.pid} exit=${exit}\n${out.trimEnd()}`);
  if (exit !== 0) throw new Error(`restart child failed (exit ${exit}):\n${out}\n${err}`);

  // Redelivered from SqlMessageStorage, and our chain deduped it (no duplicate append).
  expect(out).toMatch(/REDELIVERED 1 deduped=true action_hash=[0-9a-f]{64}/);
  expect(out).toMatch(/\nCHAIN_OK 1\n/);

  // Fold checkpoint committed and hydration consumed the seed (0 replayed actions).
  expect(out).toMatch(/CHECKPOINT_HYDRATED revision=2 nonCheckpointActions=0 history=0/);

  // DeliverAt residual: fires only after now+1500ms, within poll slack.
  const residualMatch = out.match(/DELIVER_AT residual_ms=(\d+) /);
  if (residualMatch === null) throw new Error(`missing DELIVER_AT marker:\n${out}`);
  const residual = Number(residualMatch[1]);
  expect(residual).toBeGreaterThanOrEqual(1500);
  expect(residual).toBeLessThan(3500);

  // Final chain: prompt(turn-1) + fold.checkpoint + prompt(turn-2), hashes verified by the child.
  expect(out).toMatch(/CHAIN_OK 3\n/);
  expect(out).toMatch(/HYDRATED_FINAL revision=3 nonCheckpointActions=1 history=0/);
  expect(actionCount()).toBe(3);
  {
    const db = new Database(fileFor(root, sessionId), { readonly: true });
    try {
      const kinds = db
        .query<{ kind: string; id: string }, [string]>(
          "SELECT kind, id FROM action WHERE session_id = ? ORDER BY ordinal ASC",
        )
        .all(sessionId);
      expect(kinds.map((row) => row.kind)).toEqual(["prompt", "fold.checkpoint", "prompt"]);
      expect(kinds.filter((row) => row.id === "turn-1").length).toBe(1);
    } finally {
      db.close();
    }
  }

  // Both mailbox rows are processed after restart.
  const afterRestart = messageRows().filter((row) => row.entity_type === "CrashSession");
  console.log(`[check2] cluster_messages after restart: ${JSON.stringify(afterRestart)}`);
  expect(afterRestart.length).toBe(2);
  for (const row of afterRestart) expect(Number(row.processed)).toBe(1);
  const scheduled = afterRestart.find((row) => row.tag === "Scheduled");
  expect(scheduled?.deliver_at).not.toBeNull();
}, 60_000);
