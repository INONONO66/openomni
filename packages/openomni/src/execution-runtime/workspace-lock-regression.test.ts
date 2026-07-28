import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLock } from "./workspace-lock.js";

const LOCK_ROOT = join(tmpdir(), "openomni-workspace-locks");
const OWNER_FILE = "owner.json";

function makeWorkspace(): string {
  return `/tmp/test-workspace-${crypto.randomUUID()}`;
}

function lockKey(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex");
}

function lockPath(workspace: string): string {
  return join(LOCK_ROOT, lockKey(workspace));
}

function unsafeFilePath(workspace: string): string {
  return join(LOCK_ROOT, `${lockKey(workspace)}.unsafe.json`);
}

describe("WorkspaceLock regression coverage", () => {
  test("rejects queued waiters when the workspace becomes unsafe", async () => {
    const workspace = makeWorkspace();
    await WorkspaceLock.acquire(workspace, "holder");

    const waiter = WorkspaceLock.acquire(workspace, "waiter", 500).catch((error) => error);
    await Bun.sleep(0);

    WorkspaceLock.markUnsafe(workspace, "unknown settlement");

    const blocked = await waiter;
    expect(blocked).toBeInstanceOf(Error);
    expect((blocked as Error).message).toContain("workspace marked unsafe");

    WorkspaceLock.release(workspace, "holder");
    WorkspaceLock.clearUnsafe(workspace);
    await WorkspaceLock.acquire(workspace, "probe-after-unsafe", 50);
    WorkspaceLock.release(workspace, "probe-after-unsafe");
  });

  test("reaps ownerless stale external lock directories", async () => {
    const workspace = makeWorkspace();
    const path = lockPath(workspace);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    const staleTime = new Date(Date.now() - 2_000);
    utimesSync(path, staleTime, staleTime);

    await WorkspaceLock.acquire(workspace, "replacement", 50);

    WorkspaceLock.release(workspace, "replacement");
    rmSync(path, { recursive: true, force: true });
  });

  test("reaps external locks whose owner process is gone", async () => {
    const workspace = makeWorkspace();
    const path = lockPath(workspace);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, OWNER_FILE),
      JSON.stringify({ runId: "dead-owner", pid: 999_999_999, acquiredAt: Date.now() }),
      "utf-8",
    );

    await WorkspaceLock.acquire(workspace, "replacement", 50);

    WorkspaceLock.release(workspace, "replacement");
    rmSync(path, { recursive: true, force: true });
  });

  test("does not reap external locks owned by a live process", async () => {
    const workspace = makeWorkspace();
    const path = lockPath(workspace);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, OWNER_FILE),
      JSON.stringify({ runId: "live-owner", pid: process.pid, acquiredAt: Date.now() }),
      "utf-8",
    );

    const blocked = await WorkspaceLock.acquire(workspace, "waiter", 30).catch((error) => error);

    expect(blocked).toBeInstanceOf(Error);
    expect((blocked as Error).message).toContain("workspace lock timeout");
    rmSync(path, { recursive: true, force: true });
  });

  test("malformed persisted unsafe markers fail closed", async () => {
    const workspace = makeWorkspace();
    mkdirSync(LOCK_ROOT, { recursive: true });
    writeFileSync(unsafeFilePath(workspace), JSON.stringify({ markedAt: Date.now() }), "utf-8");

    const blocked = await WorkspaceLock.acquire(workspace, "probe-malformed", 50).catch(
      (error) => error,
    );

    expect(blocked).toBeInstanceOf(Error);
    expect((blocked as Error).message).toContain("workspace marked unsafe");
    WorkspaceLock.clearUnsafe(workspace);
  });
});
