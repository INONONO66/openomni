import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";
import type { CliDeps } from "../src/cli/commands";
import { runCli } from "../src/cli/commands";
import type { DaemonIo, DaemonTarget, ExecResult } from "../src/cli/daemon";
import {
  daemonActive,
  daemonInstall,
  daemonStatus,
  daemonStop,
  daemonUninstall,
  renderLaunchdPlist,
  renderSystemdUnit,
  unitPath,
} from "../src/cli/daemon";
import { applyEnvFile, parseEnvFile, renderEnvFile, writeEnvFile } from "../src/cli/env-file";
import { runDoctor } from "../src/cli/doctor";
import type { DoctorPorts } from "../src/cli/doctor";
import { gatherOnboarding } from "../src/cli/onboard";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openomni-cli-"));
  directories.push(dir);
  return dir;
}

describe("env file", () => {
  test("parse: comments, blanks, quotes, and duplicate keys (last wins)", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "",
        "OPENOMNI_MODEL_ID=first",
        'OPENOMNI_MODEL_ID="second"',
        "OPENOMNI_MODEL_API_KEY='sk-123='",
        "not a line",
        "lowercase=skipped",
      ].join("\n"),
    );
    expect(parsed.get("OPENOMNI_MODEL_ID")).toBe("second");
    expect(parsed.get("OPENOMNI_MODEL_API_KEY")).toBe("sk-123=");
    expect(parsed.has("lowercase")).toBe(false);
    expect(parsed.size).toBe(2);
  });

  test("render round-trips through parse and rejects line breaks", () => {
    const entries = [{ key: "OPENOMNI_WS_PORT", value: "3000" }];
    expect(parseEnvFile(renderEnvFile(entries)).get("OPENOMNI_WS_PORT")).toBe("3000");
    expect(() => renderEnvFile([{ key: "A", value: "x\ny" }])).toThrow("line breaks");
    expect(() => renderEnvFile([{ key: "bad key", value: "x" }])).toThrow("invalid env key");
  });

  test("write creates parents and enforces 0600 on overwrite", () => {
    const path = join(tempDir(), "nested", "env");
    writeEnvFile(path, [{ key: "OPENOMNI_MODEL_ID", value: "one" }]);
    writeEnvFile(path, [{ key: "OPENOMNI_MODEL_ID", value: "two" }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf-8")).toBe("OPENOMNI_MODEL_ID=two\n");
  });

  test("apply fills only unset keys; process env wins; missing file is a no-op", () => {
    const path = join(tempDir(), "env");
    writeEnvFile(path, [
      { key: "OPENOMNI_MODEL_ID", value: "from-file" },
      { key: "OPENOMNI_WS_PORT", value: "4000" },
    ]);
    const env: Record<string, string | undefined> = { OPENOMNI_MODEL_ID: "from-process" };
    applyEnvFile(path, env);
    expect(env.OPENOMNI_MODEL_ID).toBe("from-process");
    expect(env.OPENOMNI_WS_PORT).toBe("4000");
    applyEnvFile(join(tempDir(), "absent"), env);
    expect(env.OPENOMNI_WS_PORT).toBe("4000");
  });
});

interface FakeIo extends DaemonIo {
  readonly commands: string[][];
  readonly files: Map<string, string>;
}

function fakeIo(respond: (argv: readonly string[]) => ExecResult): FakeIo {
  const commands: string[][] = [];
  const files = new Map<string, string>();
  return {
    commands,
    files,
    exec: (argv) => {
      commands.push([...argv]);
      return respond(argv);
    },
    writeFile: (path, content) => files.set(path, content),
    removeFile: (path) => files.delete(path),
    fileExists: (path) => files.has(path),
  };
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

const darwinTarget: DaemonTarget = {
  platform: "darwin",
  home: "/Users/owner",
  uid: 501,
  bunPath: "/opt/bun",
  entryPath: "/pkg/dist/app/main.js",
};

const linuxTarget: DaemonTarget = { ...darwinTarget, platform: "linux", home: "/home/owner" };

describe("daemon units", () => {
  test("launchd plist carries bun+entry+start, KeepAlive, and log paths", () => {
    const plist = renderLaunchdPlist(darwinTarget);
    expect(plist).toContain("<string>/opt/bun</string>");
    expect(plist).toContain("<string>/pkg/dist/app/main.js</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(plist).toContain("<string>/Users/owner/.openomni/logs/openomni.log</string>");
  });

  test("systemd unit quotes ExecStart paths and restarts on failure", () => {
    const unit = renderSystemdUnit(linuxTarget);
    expect(unit).toContain('ExecStart="/opt/bun" "/pkg/dist/app/main.js" start');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("darwin install writes the plist, boots out the old generation, bootstraps", () => {
    const io = fakeIo(() => ok);
    const message = daemonInstall(darwinTarget, io);
    expect(io.files.has(unitPath(darwinTarget))).toBe(true);
    expect(io.commands).toEqual([
      ["launchctl", "bootout", "gui/501/ai.openomni.resident"],
      ["launchctl", "bootstrap", "gui/501", unitPath(darwinTarget)],
    ]);
    expect(message).toContain("launchd");
  });

  test("linux install writes the unit then daemon-reload + enable --now", () => {
    const io = fakeIo(() => ok);
    daemonInstall(linuxTarget, io);
    expect(io.files.get(unitPath(linuxTarget))).toContain("ExecStart=");
    expect(io.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "openomni"],
    ]);
  });

  test("install surfaces the failing command with stderr", () => {
    const io = fakeIo((argv) =>
      argv[1] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed" } : ok,
    );
    expect(() => daemonInstall(darwinTarget, io)).toThrow("Bootstrap failed");
  });

  test("uninstall on a clean host reports not installed and runs nothing", () => {
    const io = fakeIo(() => ok);
    expect(daemonUninstall(linuxTarget, io)).toBe("not installed");
    expect(io.commands).toEqual([]);
  });

  test("stop failure propagates (launchctl bootout on unloaded service)", () => {
    const io = fakeIo(() => ({ code: 3, stdout: "", stderr: "No such process" }));
    expect(() => daemonStop(darwinTarget, io)).toThrow("No such process");
  });

  test("status and activity read launchctl print state", () => {
    const running = fakeIo((argv) =>
      argv[1] === "print" ? { code: 0, stdout: "state = running", stderr: "" } : ok,
    );
    running.files.set(unitPath(darwinTarget), "plist");
    expect(daemonStatus(darwinTarget, running)).toBe("active");
    const stopped = fakeIo(() => ({ code: 113, stdout: "", stderr: "" }));
    stopped.files.set(unitPath(darwinTarget), "plist");
    expect(daemonStatus(darwinTarget, stopped)).toBe("inactive");
    expect(daemonActive(linuxTarget, fakeIo(() => ({ code: 3, stdout: "inactive\n", stderr: "" })))).toBe(false);
    expect(daemonActive(linuxTarget, fakeIo(() => ({ code: 0, stdout: "active\n", stderr: "" })))).toBe(true);
  });
});

describe("onboarding", () => {
  function scriptedAsk(answers: Record<string, string>) {
    return (question: string): Promise<string> => {
      const match = Object.entries(answers).find(([prefix]) => question.startsWith(prefix));
      return Promise.resolve(match?.[1] ?? "");
    };
  }

  test("gathers required model config, applies defaults, keeps non-empty optionals", async () => {
    const entries = await gatherOnboarding(
      scriptedAsk({
        "Model id": "claude-x",
        "Model API key": "sk-1",
        "Discord bot token": "discord-1",
      }),
    );
    expect(entries).toEqual([
      { key: "OPENOMNI_MODEL_PROVIDER", value: "anthropic" },
      { key: "OPENOMNI_MODEL_ID", value: "claude-x" },
      { key: "OPENOMNI_MODEL_API_KEY", value: "sk-1" },
      { key: "OPENOMNI_WS_PORT", value: "3000" },
      { key: "DISCORD_BOT_TOKEN", value: "discord-1" },
    ]);
  });

  test("rejects a missing API key and a non-numeric port", async () => {
    await expect(gatherOnboarding(scriptedAsk({ "Model id": "m" }))).rejects.toThrow(
      "Model API key is required",
    );
    await expect(
      gatherOnboarding(
        scriptedAsk({ "Model id": "m", "Model API key": "k", "WebSocket port": "http" }),
      ),
    ).rejects.toThrow("integer");
  });
});

describe("doctor", () => {
  const healthyPorts: DoctorPorts = {
    bunVersion: "1.3.0",
    envFile: new Map([
      ["OPENOMNI_MODEL_PROVIDER", "anthropic"],
      ["OPENOMNI_MODEL_ID", "m"],
      ["OPENOMNI_MODEL_API_KEY", "k"],
      ["OPENOMNI_WS_PORT", "4123"],
    ]),
    unitInstalled: true,
    daemonActive: true,
    probeHealth: () => Promise.resolve(true),
  };

  test("all green: ok verdict and the configured port is probed", async () => {
    let probed = 0;
    const report = await runDoctor({
      ...healthyPorts,
      probeHealth: (port) => {
        probed = port;
        return Promise.resolve(true);
      },
    });
    expect(report.ok).toBe(true);
    expect(probed).toBe(4123);
    expect(report.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });

  test("missing env file fails; uninstalled daemon and silent health only warn", async () => {
    const report = await runDoctor({
      bunVersion: "1.3.0",
      envFile: undefined,
      unitInstalled: false,
      daemonActive: false,
      probeHealth: () => Promise.resolve(false),
    });
    expect(report.ok).toBe(false);
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("env file")).toBe("fail");
    expect(byName.get("daemon")).toBe("warn");
    expect(byName.get("health")).toBe("warn");
  });

  test("active daemon with unreachable health is a failure", async () => {
    const report = await runDoctor({
      ...healthyPorts,
      envFile: new Map([["OPENOMNI_MODEL_PROVIDER", "anthropic"]]),
      probeHealth: () => Promise.resolve(false),
    });
    expect(report.ok).toBe(false);
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("model config")).toBe("fail");
    expect(byName.get("health")).toBe("fail");
  });
});

describe("cli dispatch", () => {
  function deps(overrides: Partial<CliDeps> = {}): {
    readonly deps: CliDeps;
    readonly out: string[];
    readonly err: string[];
  } {
    const out: string[] = [];
    const err: string[] = [];
    const io = fakeIo(() => ok);
    return {
      out,
      err,
      deps: {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        target: darwinTarget,
        io,
        envPath: "/Users/owner/.openomni/env",
        startApp: () => Promise.resolve(),
        ask: () => Promise.resolve(""),
        writeEnv: () => undefined,
        doctorPorts: () =>
          Promise.resolve({
            bunVersion: "1.3.0",
            envFile: undefined,
            unitInstalled: false,
            daemonActive: false,
            probeHealth: () => Promise.resolve(false),
          }),
        follow: () => Promise.resolve(0),
        ...overrides,
      },
    };
  }

  test("unknown command prints usage and exits 1", async () => {
    const { deps: cli, err } = deps();
    expect(await runCli(["bogus"], cli)).toBe(1);
    expect(err[0]).toBe("unknown command: bogus");
    expect(err[1]).toContain("Usage:");
  });

  test("bare invocation shows usage with exit 0", async () => {
    const { deps: cli, out } = deps();
    expect(await runCli([], cli)).toBe(0);
    expect(out[0]).toContain("openomni daemon <verb>");
  });

  test("daemon requires a known verb", async () => {
    const { deps: cli, err } = deps();
    expect(await runCli(["daemon", "explode"], cli)).toBe(1);
    expect(err[0]).toContain("usage: openomni daemon");
  });

  test("daemon verb errors become stderr + exit 1, not a crash", async () => {
    const { deps: cli, err } = deps();
    expect(await runCli(["daemon", "start"], cli)).toBe(1);
    expect(err[0]).toContain("not installed");
  });

  test("onboard declines to overwrite an existing env file without consent", async () => {
    const writes: unknown[] = [];
    const { deps: cli, out } = deps({
      writeEnv: (entries) => writes.push(entries),
      ask: () => Promise.resolve("n"),
    });
    cli.io.writeFile(cli.envPath, "OPENOMNI_MODEL_ID=x\n");
    expect(await runCli(["onboard"], cli)).toBe(0);
    expect(writes).toEqual([]);
    expect(out[0]).toBe("keeping the existing env file");
  });

  test("doctor exit code follows the report verdict", async () => {
    const { deps: cli } = deps();
    expect(await runCli(["doctor"], cli)).toBe(1);
  });
});
