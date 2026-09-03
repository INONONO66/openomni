import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDeps } from "../src/cli/main";

const entry = new URL("../src/cli/main.ts", import.meta.url).pathname;
const directories: string[] = [];
const children = new Set<RunningCli>();
const followControllers = new Set<AbortController>();
const READY_SENTINEL = /^OpenOmni Resident listening at ws:\/\/127\.0\.0\.1:\d+\/ws$/;
const CHILD_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 2_000;
const INHERITED_CHILD_ENV_KEYS = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
] as const;

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openomni-entry-"));
  directories.push(home);
  return home;
}

function appEnv(home: string): Record<string, string> {
  const inherited = Object.fromEntries(
    INHERITED_CHILD_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  for (const command of ["launchctl", "systemctl", "loginctl"]) {
    const path = join(bin, command);
    writeFileSync(
      path,
      `#!/bin/sh
printf '%s' "${command}" >> "$OPENOMNI_COMMAND_LOG"
for arg in "$@"; do printf ' %s' "$arg" >> "$OPENOMNI_COMMAND_LOG"; done
printf '\\n' >> "$OPENOMNI_COMMAND_LOG"
case "${command} $*" in
  "systemctl "*"is-active"*) printf 'inactive\\n' ;;
  "systemctl "*"is-enabled"*) printf 'disabled\\n' ;;
  "loginctl "*"show-user"*) printf 'Linger=yes\\n' ;;
esac
`,
    );
    chmodSync(path, 0o755);
  }
  return {
    ...inherited,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    OPENOMNI_COMMAND_LOG: join(home, "commands.log"),
    OPENOMNI_DB_PATH: join(home, "storage.db"),
    OPENOMNI_MEMORY_PATH: join(home, "memory.json"),
    OPENOMNI_MACHINES_SOCKET: join(home, "machines.sock"),
    OPENOMNI_MODELS_PATH: join(home, "models.json"),
    OPENOMNI_DISABLE_MODELS_FETCH: "1",
    OPENOMNI_MODEL_PROVIDER: "anthropic",
    OPENOMNI_MODEL_ID: "test-model",
    OPENOMNI_MODEL_API_KEY: "test-key",
    OPENOMNI_WS_HOST: "127.0.0.1",
    OPENOMNI_WS_PORT: "0",
  };
}

function replaceEnvironment(env: Record<string, string | undefined>): () => void {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function boundedFollow(
  promise: Promise<number>,
  controller: AbortController,
): Promise<number> {
  try {
    return await bounded(promise, CHILD_TIMEOUT_MS, "follow child did not exit");
  } catch (error) {
    controller.abort();
    await bounded(promise, KILL_TIMEOUT_MS * 2, "follow child did not settle after cancellation");
    throw error;
  }
}

interface StreamConsumer {
  readonly result: Promise<string>;
  readonly cancel: () => Promise<void>;
}

interface RunningCli {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly stdout: StreamConsumer;
  readonly stderr: StreamConsumer;
  readonly ready: Promise<void>;
}

async function terminate(running: RunningCli): Promise<void> {
  const { child } = running;
  try {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      try {
        await bounded(child.exited, KILL_TIMEOUT_MS, "child ignored SIGTERM");
      } catch {
        child.kill("SIGKILL");
        await bounded(child.exited, KILL_TIMEOUT_MS, "child did not exit after SIGKILL");
      }
    }
  } finally {
    await Promise.all([running.stdout.cancel(), running.stderr.cancel()]);
    await bounded(
      Promise.all([running.stdout.result, running.stderr.result]),
      KILL_TIMEOUT_MS,
      "child output readers did not settle after cancellation",
    );
    children.delete(running);
  }
}

function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): StreamConsumer {
  const reader = stream.getReader();
  let active = true;
  const result = (async () => {
    const decoder = new TextDecoder();
    let output = "";
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        output += text;
        pending += text;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          onLine(pending.slice(0, newline).replace(/\r$/, ""));
          pending = pending.slice(newline + 1);
        }
      }
      const tail = decoder.decode();
      output += tail;
      pending += tail;
      if (pending.length > 0) onLine(pending.replace(/\r$/, ""));
      return output;
    } finally {
      active = false;
      reader.releaseLock();
    }
  })();
  return {
    result,
    cancel: async () => {
      if (active) await reader.cancel();
    },
  };
}

function spawnCli(args: readonly string[], env: Record<string, string>): RunningCli {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const running = {
    child,
    stdout: consumeLines(child.stdout, (line) => {
      if (READY_SENTINEL.test(line)) resolveReady();
    }),
    stderr: consumeLines(child.stderr, () => undefined),
    ready,
  } satisfies RunningCli;
  children.add(running);
  return running;
}

async function runCli(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const running = spawnCli(args, env);
  try {
    const exitCode = await bounded(
      running.child.exited,
      CHILD_TIMEOUT_MS,
      `CLI did not exit: ${args.join(" ")}`,
    );
    const [stdout, stderr] = await bounded(
      Promise.all([running.stdout.result, running.stderr.result]),
      KILL_TIMEOUT_MS,
      `CLI output did not close: ${args.join(" ")}`,
    );
    return { exitCode, stdout, stderr };
  } finally {
    await terminate(running);
  }
}

async function stopAtReady(running: RunningCli): Promise<number> {
  try {
    await bounded(running.ready, CHILD_TIMEOUT_MS, "CLI did not print the ready sentinel");
    running.child.kill("SIGTERM");
    const exitCode = await bounded(
      running.child.exited,
      CHILD_TIMEOUT_MS,
      "CLI did not exit after SIGTERM",
    );
    await bounded(
      Promise.all([running.stdout.result, running.stderr.result]),
      KILL_TIMEOUT_MS,
      "CLI output did not close after exit",
    );
    return exitCode;
  } finally {
    await terminate(running);
  }
}

afterEach(async () => {
  for (const controller of followControllers) controller.abort();
  followControllers.clear();
  await Promise.all([...children].map(terminate));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("real CLI entry", () => {
  test("managed output cancellation settles a blocked stream read", async () => {
    let canceled = false;
    const consumer = consumeLines(
      new ReadableStream<Uint8Array>({
        cancel: () => {
          canceled = true;
        },
      }),
      () => undefined,
    );

    await consumer.cancel();
    expect(await bounded(consumer.result, KILL_TIMEOUT_MS, "canceled reader did not settle")).toBe(
      "",
    );
    expect(canceled).toBe(true);
  });

  test("executes the import.meta.main exit path", async () => {
    const child = await runCli(["not-a-command"], appEnv(tempHome()));
    expect(child.exitCode).toBe(1);
  });

  test("boots the Resident and shuts it down through its installed signal handler", async () => {
    const running = spawnCli(["start"], appEnv(tempHome()));
    expect(await stopAtReady(running)).toBe(0);
  });

  test("binds doctor to the real environment, daemon query, and health probe", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".openomni"), { recursive: true });
    writeFileSync(
      join(home, ".openomni", "env"),
      "OPENOMNI_MODEL_PROVIDER=anthropic\nOPENOMNI_MODEL_ID=test-model\nOPENOMNI_MODEL_API_KEY=test-key\nOPENOMNI_WS_PORT=1\n",
    );

    const child = await runCli(["doctor"], appEnv(home));
    expect(child.exitCode).toBe(0);
    const checks = child.stdout.split("\n").flatMap((line) => {
      const match = /^(PASS|WARN|FAIL)\s+([^:]+):/.exec(line);
      return match === null ? [] : [{ status: match[1], name: match[2] }];
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.map((check) => check.name)).toContain("health");
  });

  test("binds daemon file and command IO without touching the user's home", async () => {
    const home = tempHome();
    const env = appEnv(home);
    const commandLog = join(home, "commands.log");
    const unit =
      process.platform === "darwin"
        ? join(home, "Library", "LaunchAgents", "ai.openomni.resident.plist")
        : join(home, ".config", "systemd", "user", "openomni.service");
    const install = await runCli(["daemon", "install"], env);
    expect(install.exitCode).toBe(0);
    expect(existsSync(unit)).toBe(true);

    const uninstall = await runCli(["daemon", "uninstall"], env);
    expect(uninstall.exitCode).toBe(0);
    expect(existsSync(unit)).toBe(false);

    const uid = process.getuid?.() ?? 0;
    const invocations = readFileSync(commandLog, "utf8").trim().split("\n");
    expect(invocations).toEqual(
      process.platform === "darwin"
        ? [
            `launchctl bootout gui/${uid}/ai.openomni.resident`,
            `launchctl bootstrap gui/${uid} ${unit}`,
            `launchctl bootout gui/${uid}/ai.openomni.resident`,
          ]
        : [
            "systemctl --user daemon-reload",
            "systemctl --user enable openomni",
            "systemctl --user restart openomni",
            "loginctl enable-linger",
            "systemctl --user disable --now openomni",
            "systemctl --user daemon-reload",
          ],
    );
  });

  test("refuses onboarding before prompting when stdin is not a terminal", async () => {
    const child = await runCli(["onboard"], appEnv(tempHome()));
    expect(child.exitCode).toBe(1);
  });

  test("real IO adapters execute, follow, and mutate only the requested paths", async () => {
    const root = tempHome();
    const followController = new AbortController();
    followControllers.add(followController);
    const deps = createCliDeps(root, { followSignal: followController.signal });
    const restore = replaceEnvironment(appEnv(root));
    try {
      const file = join(root, "nested", "value");
      expect(() => deps.io.exec([])).toThrow();
      expect(deps.io.exec([process.execPath, "-e", "process.stdout.write('ok')"])).toEqual({
        code: 0,
        stdout: "ok",
        stderr: "",
      });
      deps.io.writeFile(file, "value");
      expect(deps.io.fileExists(file)).toBe(true);
      deps.io.removeFile(file);
      expect(deps.io.fileExists(file)).toBe(false);
      deps.io.makeDir(file);
      expect(existsSync(file)).toBe(true);

      expect(await boundedFollow(deps.follow([]), followController)).toBe(1);
      expect(await boundedFollow(deps.follow(["/usr/bin/true"]), followController)).toBe(0);
      expect(
        await boundedFollow(deps.follow([join(root, "missing-command")]), followController),
      ).toBe(1);

      const canceledFollow = deps.follow(["/usr/bin/tail", "-f", "/dev/null"]);
      followController.abort();
      expect(
        await bounded(canceledFollow, KILL_TIMEOUT_MS * 2, "canceled follow child did not settle"),
      ).toBe(1);
    } finally {
      followController.abort();
      followControllers.delete(followController);
      restore();
    }
  });

  test("real doctor adapter reads effective process state", async () => {
    const root = tempHome();
    const deps = createCliDeps(root);
    const env = appEnv(root);
    env.OPENOMNI_MODEL_PROVIDER = "anthropic";
    env.OPENOMNI_MODEL_ID = "effective-model";
    env.OPENOMNI_MODEL_API_KEY = "effective-key";
    const restore = replaceEnvironment(env);
    try {
      const ports = await deps.doctorPorts();
      expect(Object.fromEntries(ports.effectiveEnv)).toMatchObject({
        OPENOMNI_MODEL_PROVIDER: "anthropic",
        OPENOMNI_MODEL_ID: "effective-model",
        OPENOMNI_MODEL_API_KEY: "effective-key",
      });
      expect(await ports.probeHealth(1)).toBe(false);
      // ask() rejects when stdin is not a terminal. Force the non-TTY branch
      // deterministically so the test never blocks on a real PTY.
      const isTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      try {
        await expect(deps.ask("question")).rejects.toEqual(
          new Error("onboarding requires an interactive terminal"),
        );
      } finally {
        if (isTty) Object.defineProperty(process.stdin, "isTTY", isTty);
        else Reflect.deleteProperty(process.stdin, "isTTY");
      }
    } finally {
      restore();
    }
  });

  test("real start adapter owns shutdown through the installed signal handler", async () => {
    const root = tempHome();
    const deps = createCliDeps(root);
    const restore = replaceEnvironment(appEnv(root));
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const handlers = new Map<string, () => void>();
    const once = spyOn(process, "once").mockImplementation(((
      signal: string,
      handler: () => void,
    ) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.once);
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      resolveExit(code ?? 0);
      return undefined as never;
    }) as typeof process.exit);
    try {
      await deps.startApp();
      const handler = handlers.get("SIGTERM");
      if (handler === undefined) throw new Error("expected SIGTERM handler");
      handler();
      expect(await bounded(exited, CHILD_TIMEOUT_MS, "shutdown handler did not exit")).toBe(0);
    } finally {
      exit.mockRestore();
      once.mockRestore();
      log.mockRestore();
      restore();
    }
  });
});
