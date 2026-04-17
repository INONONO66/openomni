import { describe, expect, test } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { createToolExecutor } from "./tool/executor.js";
import type { NativeTool } from "./tool/types.js";
import { WorkspaceLock } from "./workspace-lock.js";

function makeWorkspace(): string {
  return `/tmp/test-workspace-${crypto.randomUUID()}`;
}

function makeTool(
  name: string,
  riskTier: NativeTool["riskTier"],
  onExecute?: () => void,
): NativeTool {
  return {
    spec: { name, inputSchema: {} },
    riskTier,
    isReadOnly: riskTier === 0,
    isDestructive: false,
    isConcurrencySafe: false,
    execute: async (call: Tool.Call): Promise<Tool.Result> => {
      onExecute?.();
      return { id: crypto.randomUUID(), toolCallId: call.id, output: "ok" };
    },
  };
}

describe("WorkspaceLock", () => {
  test("serializes concurrent writes", async () => {
    const workspace = makeWorkspace();
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
  });

  test("multiple waiters are unblocked in queue order", async () => {
    const workspace = makeWorkspace();
    const order: string[] = [];

    await WorkspaceLock.acquire(workspace, "holder");

    const w1 = WorkspaceLock.acquire(workspace, "w1").then(() => {
      order.push("w1");
      WorkspaceLock.release(workspace, "w1");
    });
    const w2 = WorkspaceLock.acquire(workspace, "w2").then(() => {
      order.push("w2");
      WorkspaceLock.release(workspace, "w2");
    });

    WorkspaceLock.release(workspace, "holder");
    await Promise.all([w1, w2]);

    expect(order).toEqual(["w1", "w2"]);
  });

  test("rejects with timeout when lock is not released", async () => {
    const workspace = makeWorkspace();
    await WorkspaceLock.acquire(workspace, "blocker");

    await expect(WorkspaceLock.acquire(workspace, "waiter", 50)).rejects.toThrow(
      "workspace lock timeout",
    );

    WorkspaceLock.release(workspace, "blocker");
  });

  test("release by non-owner is ignored", () => {
    const workspace = makeWorkspace();
    WorkspaceLock.acquire(workspace, "owner");
    WorkspaceLock.release(workspace, "someone-else");

    const waiters: string[] = [];
    WorkspaceLock.acquire(workspace, "w1").then(() => {
      waiters.push("w1");
      WorkspaceLock.release(workspace, "w1");
    });

    expect(waiters).toHaveLength(0);
    WorkspaceLock.release(workspace, "owner");
  });
});

describe("createToolExecutor — workspace lock integration", () => {
  test("tier-0 tools bypass workspace lock", async () => {
    const workspace = makeWorkspace();
    await WorkspaceLock.acquire(workspace, "external-holder");

    let executed = false;
    const executor = createToolExecutor({
      tools: [
        makeTool("read", 0, () => {
          executed = true;
        }),
      ],
      config: { workspaceRoot: workspace },
    });

    const result = await Promise.race([
      executor({ id: "c1", tool: "read", input: {} }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), 300)),
    ]);

    expect(executed).toBe(true);
    expect((result as Tool.Result).isError).toBeFalsy();

    WorkspaceLock.release(workspace, "external-holder");
  });

  test("tier-1 tools wait for workspace lock", async () => {
    const workspace = makeWorkspace();
    const order: string[] = [];

    await WorkspaceLock.acquire(workspace, "ext");

    const executor = createToolExecutor({
      tools: [makeTool("write", 1, () => order.push("tool"))],
      config: { workspaceRoot: workspace },
    });

    const toolDone = executor({ id: "c2", tool: "write", input: {} });

    order.push("before-release");
    WorkspaceLock.release(workspace, "ext");

    await toolDone;
    order.push("after-tool");

    expect(order).toEqual(["before-release", "tool", "after-tool"]);
  });
});
