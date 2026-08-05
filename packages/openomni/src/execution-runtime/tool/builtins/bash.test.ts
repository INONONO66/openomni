import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "./bash";

function isProcessRunning(pid: number): boolean {
  const status = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  const state = status.stdout.toString().trim();
  return status.exitCode === 0 && state.length > 0 && !state.startsWith("Z");
}

describe("bashTool", () => {
  const originalAuthFile = process.env.OPENOMNI_AUTH_FILE;
  const originalDbPath = process.env.OPENOMNI_DB_PATH;
  const originalHome = process.env.HOME;

  afterEach(() => {
    restoreEnv("OPENOMNI_AUTH_FILE", originalAuthFile);
    restoreEnv("OPENOMNI_DB_PATH", originalDbPath);
    restoreEnv("HOME", originalHome);
  });

  test("scrubs auth paths from subprocess environment", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-bash-env-"));
    process.env.OPENOMNI_AUTH_FILE = "/tmp/openomni-secret-auth.json";
    process.env.OPENOMNI_DB_PATH = "/tmp/openomni-secret.db";
    process.env.HOME = "/tmp/openomni-secret-home";

    try {
      const tool = bashTool(workspace);
      const result = await tool.execute({
        id: "call-1",
        tool: "bash",
        input: {
          command:
            'printf \'auth=%s db=%s home=%s\' "$OPENOMNI_AUTH_FILE" "$OPENOMNI_DB_PATH" "$HOME"',
        },
      });

      expect(result.isError).toBeFalsy();
      expect(result.output).toBe(`auth= db= home=${workspace}`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("kills the subprocess when execution context is aborted", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-bash-abort-"));
    const childPidFileName = "child.pid";
    const readyFileName = "ready";
    const childPidFile = join(workspace, childPidFileName);
    const readyFile = join(workspace, readyFileName);
    const controller = new AbortController();
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const watcher = watch(workspace, () => {
      if (existsSync(readyFile)) resolveReady?.();
    });
    const readyTimeout = setTimeout(() => {
      rejectReady?.(new Error("bash child process did not become ready"));
    }, 1_000);

    try {
      const tool = bashTool(workspace);
      const resultPromise = tool.execute(
        {
          id: "call-abort",
          tool: "bash",
          input: {
            command:
              "trap 'exit 143' TERM; mkfifo pid.pipe; (trap '' TERM; echo \"$BASHPID\" > pid.pipe; exec sleep 1000) >/dev/null 2>&1 & read -r child_pid < pid.pipe; echo \"$child_pid\" > child.pid; touch ready; wait",
          },
        },
        { signal: controller.signal },
      );

      await ready;
      clearTimeout(readyTimeout);
      const childPid = Number.parseInt(readFileSync(childPidFile, "utf8").trim(), 10);
      controller.abort();
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Command aborted");
      expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      clearTimeout(readyTimeout);
      controller.abort();
      watcher.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("cleans detached descendants after a normal shell exit", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-bash-exit-"));
    const tool = bashTool(workspace);

    try {
      const result = await tool.execute({
        id: "call-normal-exit",
        tool: "bash",
        input: {
          command:
            'mkfifo pid.pipe; (trap \'\' HUP TERM; echo "$BASHPID" > pid.pipe; exec sleep 1000) >/dev/null 2>&1 & read -r child_pid < pid.pipe; echo "$child_pid" > child.pid; exit 0',
        },
      });
      const childPid = Number(readFileSync(join(workspace, "child.pid"), "utf8").trim());

      expect(result.isError).toBeUndefined();
      expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("keeps the first timeout reason when abort follows termination", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-bash-timeout-"));
    const marker = join(workspace, "timeout-started");
    const controller = new AbortController();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const watcher = watch(workspace, () => {
      if (existsSync(marker)) resolveStarted?.();
    });
    const tool = bashTool(workspace);

    try {
      const resultPromise = tool.execute(
        {
          id: "call-timeout-then-abort",
          tool: "bash",
          input: {
            command: "trap 'touch timeout-started; sleep 0.25; exit 0' TERM; while :; do :; done",
            timeoutMs: 50,
          },
        },
        { signal: controller.signal },
      );
      await started;
      controller.abort();

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Command timed out after 50ms");
    } finally {
      controller.abort();
      watcher.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("allows TERM cleanup before escalating an aborted process group", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-bash-term-"));
    const marker = join(workspace, "term-handled.txt");
    const readyMarkerName = "term-ready.txt";
    const controller = new AbortController();
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const watcher = watch(workspace, (_eventType, filename) => {
      if (filename?.toString() === readyMarkerName) resolveReady?.();
    });
    const readyTimeout = setTimeout(() => {
      rejectReady?.(new Error("bash TERM handler did not become ready"));
    }, 1_000);

    try {
      const tool = bashTool(workspace);
      const resultPromise = tool.execute(
        {
          id: "call-term",
          tool: "bash",
          input: {
            command:
              "trap 'exit 0' TERM; (trap 'sleep 0.25; touch term-handled.txt; exit 0' TERM; touch term-ready.txt; while :; do :; done) & wait",
          },
        },
        { signal: controller.signal },
      );

      await ready;
      clearTimeout(readyTimeout);
      controller.abort();
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      clearTimeout(readyTimeout);
      controller.abort();
      watcher.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
