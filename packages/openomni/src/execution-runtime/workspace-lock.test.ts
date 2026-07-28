import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLock } from "./workspace-lock.js";
import { createWorkspaceIdentity, type WorkspaceIdentity } from "./workspace-identity.js";

async function withWorkspace(run: (workspace: WorkspaceIdentity) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "openomni-workspace-lock-test-"));
  try {
    await run(createWorkspaceIdentity(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("WorkspaceLock", () => {
  test("serializes concurrent writes", () =>
    withWorkspace(async (workspace) => {
      const order: number[] = [];

      await WorkspaceLock.acquire(workspace, "r1");
      const r2 = WorkspaceLock.acquire(workspace, "r2").then(() => {
        order.push(2);
        WorkspaceLock.release(workspace, "r2");
      });

      order.push(1);
      WorkspaceLock.release(workspace, "r1");
      await r2;

      expect(order).toEqual([1, 2]);
    }));

  test("unblocks waiters in queue order", () =>
    withWorkspace(async (workspace) => {
      const order: string[] = [];

      await WorkspaceLock.acquire(workspace, "holder");
      const first = WorkspaceLock.acquire(workspace, "first").then(() => {
        order.push("first");
        WorkspaceLock.release(workspace, "first");
      });
      const second = WorkspaceLock.acquire(workspace, "second").then(() => {
        order.push("second");
        WorkspaceLock.release(workspace, "second");
      });

      WorkspaceLock.release(workspace, "holder");
      await Promise.all([first, second]);

      expect(order).toEqual(["first", "second"]);
    }));

  test("rejects with timeout when the lock is not released", () =>
    withWorkspace(async (workspace) => {
      await WorkspaceLock.acquire(workspace, "blocker");
      try {
        const error = await WorkspaceLock.acquire(workspace, "waiter", 50).catch(
          (caught) => caught,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("workspace lock timeout");
      } finally {
        WorkspaceLock.release(workspace, "blocker");
      }
    }));

  test("ignores release by a non-owner", () =>
    withWorkspace(async (workspace) => {
      await WorkspaceLock.acquire(workspace, "owner");
      WorkspaceLock.release(workspace, "someone-else");

      const error = await WorkspaceLock.acquire(workspace, "waiter", 50).catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("workspace lock timeout");

      WorkspaceLock.release(workspace, "owner");
    }));
});
