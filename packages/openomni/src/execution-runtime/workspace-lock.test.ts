import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createToolExecutor } from "./tool/executor.js";
import { bashTool } from "./tool/builtins/bash.js";
import type { NativeTool } from "./tool/types.js";
import { WorkspaceLock } from "./workspace-lock.js";
import { lockKey } from "./workspace-lock-files.js";
import { LOCK_ROOT, OWNER_FILE, STALE_GRACE_MS } from "./workspace-lock-types.js";

/**
 * The trace the real caller attaches to every tool call. The executor inherits
 * it rather than mint one, so a test that omits it exercises a path production
 * does not have.
 */
const RUN_TRACE = {
  traceContext: { traceId: "trace-executor-test", sessionId: "session-1", runId: "run-1" },
} as const;

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

    const error = await WorkspaceLock.acquire(workspace, "waiter", 50).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("workspace lock timeout");

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

  test("unsafe markers clear only for the matching token", async () => {
    const workspace = makeWorkspace();

    WorkspaceLock.markUnsafe(workspace, "unknown settlement", "call-a");
    WorkspaceLock.clearUnsafe(workspace, "call-b");

    const blocked = await WorkspaceLock.acquire(workspace, "probe-mismatch", 50).catch(
      (error) => error,
    );
    expect(blocked).toBeInstanceOf(Error);
    expect((blocked as Error).message).toContain("workspace marked unsafe");

    WorkspaceLock.clearUnsafe(workspace, "call-a");
    await WorkspaceLock.acquire(workspace, "probe-match", 50);
    WorkspaceLock.release(workspace, "probe-match");
  });

  test("settlement token received before unsafe mark suppresses stale unsafe marker", async () => {
    const workspace = makeWorkspace();

    WorkspaceLock.clearUnsafe(workspace, "already-settled-call");
    WorkspaceLock.markUnsafe(workspace, "late unknown settlement", "already-settled-call");

    await WorkspaceLock.acquire(workspace, "probe-settled-first", 50);
    WorkspaceLock.release(workspace, "probe-settled-first");
  });
});

describe("WorkspaceLock fail-closed lock/unsafe reads (audit A T4a/T4b)", () => {
  test("does NOT reap a stale lock whose owner file is unreadable/corrupt (T4a)", async () => {
    const workspace = makeWorkspace();
    const dir = join(LOCK_ROOT, lockKey(workspace));
    mkdirSync(dir, { recursive: true });
    // Owner file present but unparseable — its holder may be live.
    writeFileSync(join(dir, OWNER_FILE), "{ this is not json", "utf-8");
    // Age the dir far past the grace: the OLD mtime-grace path WOULD reap it.
    const old = new Date(Date.now() - 10 * STALE_GRACE_MS);
    utimesSync(dir, old, old);

    try {
      const blocked = await WorkspaceLock.acquire(workspace, "probe", 60).catch((error) => error);
      expect(blocked).toBeInstanceOf(Error);
      expect((blocked as Error).message).toContain("workspace lock timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("still reaps a stale lock whose owner file is genuinely absent (grace intact)", async () => {
    const workspace = makeWorkspace();
    const dir = join(LOCK_ROOT, lockKey(workspace));
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 10 * STALE_GRACE_MS);
    utimesSync(dir, old, old);

    // No owner.json → the mtime grace legitimately reaps: acquire succeeds.
    await WorkspaceLock.acquire(workspace, "probe", 500);
    WorkspaceLock.release(workspace, "probe");
  });

  test("crash before the atomic rename (only a .tmp remains) is grace-reapable, not a deadlock (T4a)", async () => {
    const workspace = makeWorkspace();
    const dir = join(LOCK_ROOT, lockKey(workspace));
    mkdirSync(dir, { recursive: true });
    // Simulate a hard crash mid-acquisition: the temp owner was written but
    // never renamed into OWNER_FILE. Only the leftover ".tmp" exists; there is
    // NO OWNER_FILE. Atomic publish guarantees this is the only crash shape —
    // readOwner sees "missing", so the mtime grace must still reap it.
    writeFileSync(join(dir, `${OWNER_FILE}.tmp`), '{"runId":"dead","pid":999999}', "utf-8");
    const old = new Date(Date.now() - 10 * STALE_GRACE_MS);
    utimesSync(dir, old, old);

    await WorkspaceLock.acquire(workspace, "probe", 500);
    WorkspaceLock.release(workspace, "probe");
  });

  test("reads an unreadable/corrupt unsafe marker as UNSAFE (T4b)", async () => {
    const workspace = makeWorkspace();
    mkdirSync(LOCK_ROOT, { recursive: true });
    const marker = join(LOCK_ROOT, `${lockKey(workspace)}.unsafe.json`);
    writeFileSync(marker, "{ corrupt unsafe marker", "utf-8");

    try {
      const blocked = await WorkspaceLock.acquire(workspace, "probe", 60).catch((error) => error);
      expect(blocked).toBeInstanceOf(Error);
      expect((blocked as Error).message).toContain("workspace marked unsafe");
    } finally {
      rmSync(marker, { force: true });
    }
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
      executor({ id: "c1", tool: "read", input: {} }, RUN_TRACE),
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

    const toolDone = executor({ id: "c2", tool: "write", input: {} }, RUN_TRACE);

    order.push("before-release");
    WorkspaceLock.release(workspace, "ext");

    await toolDone;
    order.push("after-tool");

    expect(order).toEqual(["before-release", "tool", "after-tool"]);
  });

  test("tier-1 tools release workspace lock after execution errors", async () => {
    const workspace = makeWorkspace();
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: async () => {
            throw new Error("boom");
          },
        },
      ],
      config: { workspaceRoot: workspace },
    });

    const result = await executor({ id: "c3", tool: "write", input: {} }, RUN_TRACE);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");

    await WorkspaceLock.acquire(workspace, "probe", 50);
    WorkspaceLock.release(workspace, "probe");
  });

  test("pre-aborted tier-1 tools do not acquire the workspace lock", async () => {
    const workspace = makeWorkspace();
    await WorkspaceLock.acquire(workspace, "holder");
    const controller = new AbortController();
    controller.abort();
    let executed = false;
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: async (call) => {
            executed = true;
            return { id: crypto.randomUUID(), toolCallId: call.id, output: "unexpected" };
          },
        },
      ],
      config: { workspaceRoot: workspace, timeoutMs: { tier1: 10 } },
    });

    try {
      const result = await executor(
        { id: "pre-aborted", tool: "write", input: {} },
        { ...RUN_TRACE, signal: controller.signal },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toBe("Tool execution aborted");
      expect(executed).toBe(false);
    } finally {
      WorkspaceLock.release(workspace, "holder");
    }
  });

  test("tier-1 tools abort promptly while waiting for the workspace lock", async () => {
    const workspace = makeWorkspace();
    await WorkspaceLock.acquire(workspace, "holder");
    const controller = new AbortController();
    let executed = false;
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: async (call) => {
            executed = true;
            return { id: crypto.randomUUID(), toolCallId: call.id, output: "unexpected" };
          },
        },
      ],
      config: { workspaceRoot: workspace },
    });

    try {
      const resultPromise = executor(
        { id: "abort-while-waiting", tool: "write", input: {} },
        { ...RUN_TRACE, signal: controller.signal },
      );
      await Bun.sleep(10);
      controller.abort();
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(result.output).toBe("Tool execution aborted");
      expect(executed).toBe(false);
    } finally {
      WorkspaceLock.release(workspace, "holder");
    }
  });

  test("tier-1 tools keep the workspace lock until timed-out execution settles", async () => {
    const workspace = makeWorkspace();
    let settleTool: ((result: Tool.Result) => void) | undefined;
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: (call) =>
            new Promise<Tool.Result>((resolve) => {
              settleTool = resolve;
            }).then((result) => ({ ...result, toolCallId: call.id })),
        },
      ],
      config: { workspaceRoot: workspace, timeoutMs: { tier1: 10 } },
    });

    const result = await executor({ id: "c4", tool: "write", input: {} }, RUN_TRACE);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("timeout after 10ms");

    const blockedProbe = await WorkspaceLock.acquire(workspace, "probe-before-settle", 30).catch(
      (error) => error,
    );
    expect(blockedProbe).toBeInstanceOf(Error);
    expect((blockedProbe as Error).message).toContain("workspace lock timeout");

    settleTool?.({ id: "late-result", toolCallId: "c4", output: "late" });
    await Bun.sleep(0);

    await WorkspaceLock.acquire(workspace, "probe-after-settle", 50);
    WorkspaceLock.release(workspace, "probe-after-settle");
  });

  test("same executor cannot reenter workspace while a timed-out tool is settling", async () => {
    const workspace = makeWorkspace();
    let firstStarted = false;
    let secondStarted = false;
    let settleFirst: ((result: Tool.Result) => void) | undefined;
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: (call) => {
            if (!firstStarted) {
              firstStarted = true;
              return new Promise<Tool.Result>((resolve) => {
                settleFirst = resolve;
              }).then((result) => ({ ...result, toolCallId: call.id }));
            }
            secondStarted = true;
            return Promise.resolve({
              id: crypto.randomUUID(),
              toolCallId: call.id,
              output: "second",
            });
          },
        },
      ],
      config: { workspaceRoot: workspace, timeoutMs: { tier1: 10 } },
    });

    const first = await executor({ id: "c4-first", tool: "write", input: {} }, RUN_TRACE);
    expect(first.output).toBe("timeout after 10ms");

    let secondDone = false;
    const second = executor({ id: "c4-second", tool: "write", input: {} }, RUN_TRACE).then(
      (result) => {
        secondDone = true;
        return result;
      },
    );
    await Bun.sleep(20);
    expect(secondStarted).toBe(false);
    expect(secondDone).toBe(false);

    settleFirst?.({ id: "late-result", toolCallId: "c4-first", output: "late" });
    const secondResult = await second;
    expect(secondStarted).toBe(true);
    expect(secondResult.output).toBe("second");
  });

  test("tier-1 tools mark workspace unsafe after post-timeout settlement grace", async () => {
    const workspace = makeWorkspace();
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: () => new Promise<Tool.Result>(() => undefined),
        },
      ],
      config: { workspaceRoot: workspace, timeoutMs: { tier1: 10 }, postTimeoutSettleGraceMs: 20 },
    });

    const result = await executor({ id: "c4-grace", tool: "write", input: {} }, RUN_TRACE);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("timeout after 10ms");

    const blockedProbe = await WorkspaceLock.acquire(workspace, "probe-before-grace", 5).catch(
      (error) => error,
    );
    expect(blockedProbe).toBeInstanceOf(Error);
    expect((blockedProbe as Error).message).toContain("workspace lock timeout");

    await Bun.sleep(30);

    const unsafeProbe = await WorkspaceLock.acquire(workspace, "probe-after-grace", 50).catch(
      (error) => error,
    );
    expect(unsafeProbe).toBeInstanceOf(Error);
    expect((unsafeProbe as Error).message).toContain("workspace marked unsafe");
    WorkspaceLock.clearUnsafe(workspace);
  });

  test("tier-1 tools mark workspace unsafe when a proxy reports unknown settlement", async () => {
    const workspace = makeWorkspace();
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: async (call) => ({
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: "Tool call aborted",
            isError: true,
            settlement: "unknown",
          }),
        },
      ],
      config: { workspaceRoot: workspace, postTimeoutSettleGraceMs: 20 },
    });

    const result = await executor({ id: "c4-unknown", tool: "write", input: {} }, RUN_TRACE);
    expect(result.isError).toBe(true);
    expect(result.settlement).toBe("unknown");

    const unsafeProbe = await WorkspaceLock.acquire(workspace, "probe-unknown", 50).catch(
      (error) => error,
    );
    expect(unsafeProbe).toBeInstanceOf(Error);
    expect((unsafeProbe as Error).message).toContain("workspace marked unsafe");
    WorkspaceLock.clearUnsafe(workspace);
  });

  test("unknown-settlement unsafe marker clears only for the proxy call that reported it", async () => {
    const workspace = makeWorkspace();
    const proxyCallId = "proxy-call-id";
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: async () => ({
            id: proxyCallId,
            toolCallId: proxyCallId,
            output: "Tool call aborted",
            isError: true,
            settlement: "unknown",
          }),
        },
      ],
      config: { workspaceRoot: workspace, postTimeoutSettleGraceMs: 20 },
    });

    await executor({ id: "agent-call-id", tool: "write", input: {} }, RUN_TRACE);
    WorkspaceLock.clearUnsafe(workspace, "unrelated-call");

    const blocked = await WorkspaceLock.acquire(workspace, "probe-wrong-call", 50).catch(
      (error) => error,
    );
    expect(blocked).toBeInstanceOf(Error);
    expect((blocked as Error).message).toContain("workspace marked unsafe");

    WorkspaceLock.clearUnsafe(workspace, proxyCallId);
    await WorkspaceLock.acquire(workspace, "probe-right-call", 50);
    WorkspaceLock.release(workspace, "probe-right-call");
  });

  test("tier-1 tools release workspace lock after cooperative timeout aborts", async () => {
    const workspace = makeWorkspace();
    const executor = createToolExecutor({
      tools: [
        {
          ...makeTool("write", 1),
          execute: async (_call, context) => {
            const signal = context?.signal;
            return await new Promise<Tool.Result>((_, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  const error = new Error("cooperative abort");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
            });
          },
        },
      ],
      config: { workspaceRoot: workspace, timeoutMs: { tier1: 10 } },
    });

    const result = await executor({ id: "c5", tool: "write", input: {} }, RUN_TRACE);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("timeout after 10ms");

    await WorkspaceLock.acquire(workspace, "probe", 50);
    WorkspaceLock.release(workspace, "probe");
  });

  test("aborts bash side effects before releasing the workspace lock after timeout", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-lock-bash-timeout-"));
    const marker = join(workspace, "late-write.txt");

    try {
      const executor = createToolExecutor({
        tools: [bashTool(workspace)],
        config: { workspaceRoot: workspace, timeoutMs: { tier2: 20 } },
      });

      const result = await executor(
        {
          id: "c6",
          tool: "bash",
          input: { command: "(sleep 0.2; touch late-write.txt) & wait" },
        },
        RUN_TRACE,
      );
      await Bun.sleep(300);

      expect(result.isError).toBe(true);
      expect(result.output).toBe("timeout after 20ms");
      expect(existsSync(marker)).toBe(false);

      await WorkspaceLock.acquire(workspace, "probe", 50);
      WorkspaceLock.release(workspace, "probe");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
