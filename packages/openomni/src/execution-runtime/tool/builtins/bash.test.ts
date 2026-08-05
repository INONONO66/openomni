import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "./bash";

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
      let childAlive = true;
      try {
        process.kill(childPid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
          childAlive = false;
        } else {
          throw error;
        }
      }

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Command aborted");
      expect(childAlive).toBe(false);
    } finally {
      clearTimeout(readyTimeout);
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
              "trap 'touch term-handled.txt; exit 0' TERM; touch term-ready.txt; while :; do sleep 1; done",
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
