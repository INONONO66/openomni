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
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createCliDeps } from "../src/cli/main";

const entry = new URL("../src/cli/main.ts", import.meta.url).pathname;
const directories: string[] = [];
const MUTATED_ENV_KEYS = [
  "HOME",
  "PATH",
  "OPENOMNI_DB_PATH",
  "OPENOMNI_MEMORY_PATH",
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_COMMAND_LOG",
  "OPENOMNI_WS_HOST",
  "OPENOMNI_WS_PORT",
  "OPENOMNI_VAULT_KEY",
] as const;

function saveMutatedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreMutatedEnv(saved: Record<string, string | undefined>): void {
  for (const key of MUTATED_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openomni-entry-"));
  directories.push(home);
  return home;
}

function appEnv(home: string): Record<string, string> {
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
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    OPENOMNI_COMMAND_LOG: join(home, "commands.log"),
    OPENOMNI_DB_PATH: join(home, "storage.db"),
    OPENOMNI_MEMORY_PATH: join(home, "memory.json"),
    OPENOMNI_MODEL_PROVIDER: "anthropic",
    OPENOMNI_MODEL_ID: "test-model",
    OPENOMNI_MODEL_API_KEY: "test-key",
    OPENOMNI_WS_HOST: "127.0.0.1",
    OPENOMNI_WS_PORT: "0",
  } as Record<string, string>;
}

const READY_SENTINEL = /^OpenOmni Resident listening at ws:\/\/127\.0\.0\.1:\d+\/ws$/;

function waitForExactLine(
  stdout: ReadableStream<Uint8Array>,
  expected: RegExp,
  timeoutMs = 5_000,
): Promise<void> {
  const input = Readable.from(stdout);
  const lines = createInterface({ input });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stdout line: ${expected}`));
    }, timeoutMs);
    const onLine = (line: string): void => {
      if (!expected.test(line)) return;
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`stdout closed before line: ${expected}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      lines.off("line", onLine);
      lines.off("close", onClose);
      lines.close();
    };
    lines.on("line", onLine);
    lines.once("close", onClose);
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("real CLI entry", () => {
  test("executes the import.meta.main exit path", () => {
    const child = Bun.spawnSync([process.execPath, entry, "not-a-command"], {
      env: appEnv(tempHome()),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(1);
  });

  test("boots the Resident and shuts it down through its installed signal handler", async () => {
    const child = Bun.spawn([process.execPath, entry, "start"], {
      env: appEnv(tempHome()),
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await waitForExactLine(child.stdout, READY_SENTINEL);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
    }
  });

  test("binds doctor to the real environment, daemon query, and health probe", () => {
    const home = tempHome();
    mkdirSync(join(home, ".openomni"), { recursive: true });
    writeFileSync(
      join(home, ".openomni", "env"),
      "OPENOMNI_MODEL_PROVIDER=anthropic\nOPENOMNI_MODEL_ID=test-model\nOPENOMNI_MODEL_API_KEY=test-key\nOPENOMNI_WS_PORT=1\n",
    );

    const child = Bun.spawnSync([process.execPath, entry, "doctor"], {
      env: appEnv(home),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(0);
    const checks = child.stdout
      .toString()
      .split("\n")
      .flatMap((line) => {
        const match = /^(PASS|WARN|FAIL)\s+([^:]+):/.exec(line);
        return match === null ? [] : [{ status: match[1], name: match[2] }];
      });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.map((check) => check.name)).toContain("health");
  });

  test("binds daemon file and command IO without touching the user's home", () => {
    const home = tempHome();
    const env = appEnv(home);
    const commandLog = join(home, "commands.log");
    const unit =
      process.platform === "darwin"
        ? join(home, "Library", "LaunchAgents", "ai.openomni.resident.plist")
        : join(home, ".config", "systemd", "user", "openomni.service");
    const install = Bun.spawnSync([process.execPath, entry, "daemon", "install"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(install.exitCode).toBe(0);
    expect(existsSync(unit)).toBe(true);

    const uninstall = Bun.spawnSync([process.execPath, entry, "daemon", "uninstall"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
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

  test("runs provisioning initialization through the real binder", () => {
    const home = tempHome();
    const child = Bun.spawnSync([process.execPath, entry, "init"], {
      env: appEnv(home),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(0);
    expect(existsSync(join(home, ".openomni", "vault.key"))).toBe(true);
    expect(child.stdout.toString()).toContain("minted vault key file");
  });

  test("refuses onboarding before prompting when stdin is not a terminal", () => {
    const child = Bun.spawnSync([process.execPath, entry, "onboard"], {
      env: appEnv(tempHome()),
      stdin: new Blob([]),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(1);
  });

  test("real IO adapters execute, follow, and mutate only the requested paths", async () => {
    const deps = createCliDeps();
    const root = tempHome();
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

    expect(await deps.follow([])).toBe(1);
    expect(await deps.follow(["/usr/bin/true"])).toBe(0);
    expect(await deps.follow([join(root, "missing-command")])).toBe(1);
  });

  test("real doctor and init adapters read effective process state", async () => {
    const deps = createCliDeps();
    const root = tempHome();
    const saved = saveMutatedEnv();
    process.env.OPENOMNI_DB_PATH = join(root, "init.db");
    process.env.OPENOMNI_MODEL_PROVIDER = "anthropic";
    process.env.OPENOMNI_MODEL_ID = "test-model";
    process.env.OPENOMNI_MODEL_API_KEY = "test-key";
    process.env.OPENOMNI_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const ports = await deps.doctorPorts();
      expect(ports.effectiveEnv).toBeInstanceOf(Map);
      expect(await ports.probeHealth(1)).toBe(false);
      expect(await deps.runInit()).toBeArray();
      await expect(deps.ask("question")).rejects.toThrow();
    } finally {
      restoreMutatedEnv(saved);
    }
  });

  test("real start adapter owns shutdown through the installed signal handler", async () => {
    const root = tempHome();
    const saved = saveMutatedEnv();
    Object.assign(process.env, appEnv(root));
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      resolveExit(code ?? 0);
      return undefined as never;
    }) as typeof process.exit);
    try {
      await createCliDeps().startApp();
      process.emit("SIGTERM");
      expect(await exited).toBe(0);
    } finally {
      exit.mockRestore();
      log.mockRestore();
      restoreMutatedEnv(saved);
    }
  });
});
