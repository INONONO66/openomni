import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLock } from "./workspace-lock.js";
import { createWorkspaceIdentity, type WorkspaceIdentity } from "./workspace-identity.js";

const LOCK_ROOT = join(tmpdir(), "openomni-workspace-locks");
const OWNER_FILE = "owner.json";

function lockPath(workspace: WorkspaceIdentity): string {
  const key = createHash("sha256").update(workspace.workspaceId).digest("hex");
  return join(LOCK_ROOT, key);
}

async function withWorkspace(run: (workspace: WorkspaceIdentity) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "openomni-workspace-lock-regression-"));
  try {
    await run(createWorkspaceIdentity(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("WorkspaceLock regression coverage", () => {
  test("reaps ownerless stale external lock directories", () =>
    withWorkspace(async (workspace) => {
      const path = lockPath(workspace);
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path, { recursive: true });
      const staleTime = new Date(Date.now() - 2_000);
      utimesSync(path, staleTime, staleTime);

      await WorkspaceLock.acquire(workspace, "replacement", 50);
      WorkspaceLock.release(workspace, "replacement");
      rmSync(path, { recursive: true, force: true });
    }));

  test("reaps external locks whose owner process is gone", () =>
    withWorkspace(async (workspace) => {
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
    }));

  test("does not reap external locks owned by a live process", () =>
    withWorkspace(async (workspace) => {
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
    }));
});
