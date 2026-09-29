// W5.1 check2 as a package test (plan §4): SIGKILL mid-turn loses nothing —
// the msg.received chain action is durable, the unacked envelope survives in
// cluster_messages, redelivery dedupes against OUR chain (identical
// action_hash), real turn shapes land on the chain (F12 chain-level evidence),
// DeliverAt honors its not-before residual, and a duplicate client send of the
// same messageId yields exactly one chain row (R3).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clusterMessages,
  readChain,
  readUntil,
  runCluster,
  sendPrompt,
  sessionFileFor,
} from "../helpers/cluster-runtime";

const dir = mkdtempSync(join(tmpdir(), "w52-entity-crash-"));
const sessionsDir = join(dir, "sessions");
mkdirSync(sessionsDir, { recursive: true });
const catalogFile = join(dir, "catalog.sqlite");
const sessionId = "s-crash";
const sessionFile = sessionFileFor(sessionsDir, sessionId);
const childScript = join(import.meta.dir, "..", "helpers", "cluster-crash-child.ts");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function spawnChild(mode: "crash" | "restart") {
  return Bun.spawn({
    cmd: [process.execPath, childScript, sessionsDir, catalogFile, sessionId, mode],
    cwd: join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("SIGKILL mid-turn: chain action durable, envelope unprocessed, redelivery dedupes, DeliverAt residual holds", async () => {
  // ---- phase 1: crash ------------------------------------------------------
  const crash = spawnChild("crash");
  const crashOut = await readUntil(crash.stdout, /APPENDED /, 30_000);
  process.kill(crash.pid, "SIGKILL");
  const crashExit = await crash.exited;
  expect(crashExit).toBe(137);
  expect(crashOut).toMatch(/APPENDED turn=.+ message=crash-m1/);

  // The msg.received append committed durably before the kill.
  const appended = readChain(sessionFile, sessionId).filter((row) => row.id === "crash-m1");
  expect(appended).toHaveLength(1);
  const durableHash = appended[0]?.action_hash ?? "";
  expect(durableHash).toMatch(/^[0-9a-f]{64}$/);

  // The mailbox row survived the SIGKILL unprocessed (ack strictly after the
  // turn seal, check4 F2 ordering).
  const afterCrash = clusterMessages(catalogFile, "Session");
  expect(afterCrash.length).toBeGreaterThanOrEqual(1);
  expect(afterCrash.every((row) => row.processed === 0)).toBe(true);

  // ---- phase 2: restart ----------------------------------------------------
  const restart = spawnChild("restart");
  const [out, err, exit] = await Promise.all([
    new Response(restart.stdout).text(),
    new Response(restart.stderr).text(),
    restart.exited,
  ]);
  if (exit !== 0) throw new Error(`restart child failed (exit ${exit}):\n${out}\n${err}`);

  // Redelivered and deduped: same single chain row, identical action_hash.
  expect(out).toMatch(new RegExp(`REDELIVERED count=1 ordinal=\\d+ action_hash=${durableHash}`));

  // F12: the recovered turn committed real action shapes (turn intent +
  // terminal on the chain, not just the message append) and every hash links.
  const shapes = out.match(/SHAPES count=(\d+) kinds=(\S+)/);
  if (shapes === null) throw new Error(`missing SHAPES marker:\n${out}`);
  const kinds = (shapes[2] ?? "").split(",");
  expect(kinds.filter((kind) => kind === "turn").length).toBeGreaterThanOrEqual(1);
  expect(out).toMatch(/CHAIN_OK [1-9]\d*/);

  // DeliverAt is a durable not-before clock: the Deadline reply resolved only
  // after the 1500ms residual elapsed (and within poll slack).
  const residualMatch = out.match(/DELIVER_AT residual_ms=(\d+)/);
  if (residualMatch === null) throw new Error(`missing DELIVER_AT marker:\n${out}`);
  const residual = Number(residualMatch[1]);
  expect(residual).toBeGreaterThanOrEqual(1500);
  expect(residual).toBeLessThan(3500);

  // Every Session envelope is processed after recovery.
  const afterRestart = clusterMessages(catalogFile, "Session");
  expect(afterRestart.length).toBeGreaterThanOrEqual(2);
  for (const row of afterRestart) {
    expect(row.processed).toBe(1);
  }
  const deadline = afterRestart.find((row) => row.tag === "Deadline");
  expect(deadline?.deliver_at).not.toBeNull();
}, 60_000);

test("R3: a duplicate client send of the same messageId appends exactly one chain row", async () => {
  const chainBefore = readChain(sessionFile, sessionId);
  const reply = await runCluster(
    { sessionsDir, catalogFile },
    sendPrompt(sessionId, "crash-m1", "crash me"),
  );
  const rows = readChain(sessionFile, sessionId).filter((row) => row.id === "crash-m1");
  expect(rows).toHaveLength(1);
  expect(reply.deduped).toBe(true);
  expect(reply.actionHash).toBe(rows[0]?.action_hash ?? "");
  // The duplicate acked without growing the chain with a second received row.
  expect(rows[0]?.ordinal).toBeLessThanOrEqual(chainBefore.length);
}, 60_000);
