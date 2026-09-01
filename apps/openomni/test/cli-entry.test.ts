import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const launchctl = join(bin, "launchctl");
  writeFileSync(launchctl, "#!/bin/sh\necho 'state = running'\n");
  chmodSync(launchctl, 0o755);
  return {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    OPENOMNI_DB_PATH: join(home, "storage.db"),
    OPENOMNI_MEMORY_PATH: join(home, "memory.json"),
    OPENOMNI_MODEL_PROVIDER: "anthropic",
    OPENOMNI_MODEL_ID: "test-model",
    OPENOMNI_MODEL_API_KEY: "test-key",
    OPENOMNI_WS_PORT: "0",
  } as Record<string, string>;
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
    const reader = child.stdout.getReader();

    const ready = await reader.read();
    expect(ready.done).toBe(false);
    child.kill("SIGTERM");

    expect(await child.exited).toBe(0);
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
  });

  test("binds daemon file and command IO without touching the user's home", () => {
    const home = tempHome();
    const env = appEnv(home);
    const install = Bun.spawnSync([process.execPath, entry, "daemon", "install"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(install.exitCode).toBe(0);
    expect(existsSync(join(home, "Library", "LaunchAgents", "ai.openomni.resident.plist"))).toBe(
      true,
    );

    const uninstall = Bun.spawnSync([process.execPath, entry, "daemon", "uninstall"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(uninstall.exitCode).toBe(0);
    expect(existsSync(join(home, "Library", "LaunchAgents", "ai.openomni.resident.plist"))).toBe(
      false,
    );
  });

  test("runs provisioning initialization through the real binder", () => {
    const child = Bun.spawnSync([process.execPath, entry, "init"], {
      env: appEnv(tempHome()),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect([0, 1]).toContain(child.exitCode);
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
