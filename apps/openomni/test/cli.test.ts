import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
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
import { processEntryPath } from "../src/process-entry-path";
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
        "export OPENOMNI_WS_PORT=4001",
        "not a line",
        "lowercase=skipped",
      ].join("\r\n"),
    );
    expect(parsed.get("OPENOMNI_MODEL_ID")).toBe("second");
    expect(parsed.get("OPENOMNI_MODEL_API_KEY")).toBe("sk-123=");
    expect(parsed.get("OPENOMNI_WS_PORT")).toBe("4001");
    expect(parsed.has("lowercase")).toBe(false);
    expect(parsed.size).toBe(3);
  });

  test("render round-trips through parse and rejects line breaks", () => {
    // Values the parser would unquote must survive a write->read cycle intact.
    const entries = [
      { key: "OPENOMNI_WS_PORT", value: "3000" },
      { key: "OPENOMNI_MODEL_API_KEY", value: '"secret"' },
      { key: "OPENOMNI_MODEL_ID", value: "'quoted'" },
    ];
    const parsed = parseEnvFile(renderEnvFile(entries));
    for (const entry of entries) {
      expect(parsed.get(entry.key)).toBe(entry.value);
    }
    expect(() => renderEnvFile([{ key: "A", value: "x\ny" }])).toThrow("line breaks");
    expect(() => renderEnvFile([{ key: "bad key", value: "x" }])).toThrow("invalid env key");
  });

  test("write replaces a symlink at the destination instead of following it", () => {
    const dir = tempDir();
    const victim = join(dir, "victim");
    const path = join(dir, "env");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, path);
    writeEnvFile(path, [{ key: "OPENOMNI_MODEL_ID", value: "m" }]);
    expect(readFileSync(victim, "utf-8")).toBe("untouched");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("OPENOMNI_MODEL_ID=m\n");
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
  readonly dirs: string[];
}

function fakeIo(respond: (argv: readonly string[]) => ExecResult): FakeIo {
  const commands: string[][] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  return {
    commands,
    files,
    dirs,
    exec: (argv) => {
      commands.push([...argv]);
      return respond(argv);
    },
    writeFile: (path, content) => files.set(path, content),
    removeFile: (path) => files.delete(path),
    makeDir: (path) => dirs.push(path),
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

  test("systemd unit escapes %, quotes, and backslashes; control chars are rejected", () => {
    const hostile: DaemonTarget = {
      ...linuxTarget,
      bunPath: '/opt/we"ird/bun',
      entryPath: "/pkg/100%/back\\slash/main.js",
    };
    const unit = renderSystemdUnit(hostile);
    expect(unit).toContain('ExecStart="/opt/we\\"ird/bun" "/pkg/100%%/back\\\\slash/main.js" start');
    // `$` must never reach systemd unescaped: ExecStart environment-expands it.
    const curly = "{X}";
    const dollar = renderSystemdUnit({ ...linuxTarget, entryPath: `/pkg/$VER/$${curly}/main.js` });
    expect(dollar).toContain(`"/pkg/$$VER/$$${curly}/main.js"`);
    expect(dollar).not.toContain("/pkg/$VER");
    expect(() => renderSystemdUnit({ ...linuxTarget, entryPath: "/pkg\nExecStart=/evil" })).toThrow(
      "control characters",
    );
    expect(() => renderLaunchdPlist({ ...darwinTarget, bunPath: "/opt\nbun" })).toThrow(
      "control characters",
    );
  });

  test("darwin install creates the log dir, writes the plist, boots out the old generation, bootstraps", () => {
    const io = fakeIo(() => ok);
    const message = daemonInstall(darwinTarget, io);
    // launchd opens the configured log paths itself; the dir must exist first.
    expect(io.dirs).toEqual(["/Users/owner/.openomni/logs"]);
    expect(io.files.has(unitPath(darwinTarget))).toBe(true);
    expect(io.commands).toEqual([
      ["launchctl", "bootout", "gui/501/ai.openomni.resident"],
      ["launchctl", "bootstrap", "gui/501", unitPath(darwinTarget)],
    ]);
    expect(message).toContain("launchd");
  });

  test("linux install reloads, enables, restarts (replacing a running old generation), enables linger", () => {
    const io = fakeIo(() => ok);
    const message = daemonInstall(linuxTarget, io);
    expect(io.files.get(unitPath(linuxTarget))).toContain("ExecStart=");
    expect(io.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "openomni"],
      ["systemctl", "--user", "restart", "openomni"],
      ["loginctl", "enable-linger"],
    ]);
    expect(message).toContain("linger enabled");
  });

  test("linux install fails hard when linger cannot be enabled", () => {
    // Exit 0 with an unmet 24/7 contract is a lie; the unit stays installed
    // and running, but the command must fail with remediation.
    const io = fakeIo((argv) =>
      argv[0] === "loginctl" ? { code: 1, stdout: "", stderr: "denied" } : ok,
    );
    expect(() => daemonInstall(linuxTarget, io)).toThrow("linger could not be enabled");
    expect(io.files.has(unitPath(linuxTarget))).toBe(true);
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

  test("uninstall removes the unit after a successful stop", () => {
    const io = fakeIo(() => ok);
    io.files.set(unitPath(linuxTarget), "unit");
    expect(daemonUninstall(linuxTarget, io)).toContain("uninstalled");
    expect(io.files.has(unitPath(linuxTarget))).toBe(false);
    expect(io.commands).toEqual([
      ["systemctl", "--user", "disable", "--now", "openomni"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  test("uninstall after a failed stop proceeds only when inactive AND disabled are proven", () => {
    const io = fakeIo((argv) => {
      if (argv[2] === "disable") return { code: 1, stdout: "", stderr: "boom" };
      if (argv[2] === "is-active") return { code: 3, stdout: "inactive\n", stderr: "" };
      if (argv[2] === "is-enabled") return { code: 1, stdout: "disabled\n", stderr: "" };
      return ok;
    });
    io.files.set(unitPath(linuxTarget), "unit");
    expect(daemonUninstall(linuxTarget, io)).toContain("uninstalled");
  });

  test("uninstall keeps the unit when the process stopped but the enable symlink survived", () => {
    // A dangling enable symlink resurrects the service on reinstall; a
    // failed disable is not success just because the process is inactive.
    const io = fakeIo((argv) => {
      if (argv[2] === "disable")
        return { code: 1, stdout: "", stderr: "could not remove default.target.wants" };
      if (argv[2] === "is-active") return { code: 3, stdout: "inactive\n", stderr: "" };
      if (argv[2] === "is-enabled") return { code: 0, stdout: "enabled\n", stderr: "" };
      return ok;
    });
    io.files.set(unitPath(linuxTarget), "unit");
    expect(() => daemonUninstall(linuxTarget, io)).toThrow("still enabled");
    expect(io.files.has(unitPath(linuxTarget))).toBe(true);
  });

  test("uninstall keeps the unit when the stop fails and the state is transitional", () => {
    // `activating` is not `inactive`: deleting the unit here orphans a
    // daemon that is actively coming up.
    const io = fakeIo((argv) => {
      if (argv[2] === "disable") return { code: 1, stdout: "", stderr: "boom" };
      if (argv[2] === "is-active") return { code: 0, stdout: "activating\n", stderr: "" };
      return ok;
    });
    io.files.set(unitPath(linuxTarget), "unit");
    expect(() => daemonUninstall(linuxTarget, io)).toThrow("could not be stopped");
    expect(io.files.has(unitPath(linuxTarget))).toBe(true);
  });

  test("darwin uninstall keeps the plist while the job is still loaded", () => {
    const io = fakeIo((argv) => {
      if (argv[1] === "bootout") return { code: 5, stdout: "", stderr: "busy" };
      if (argv[1] === "print") return { code: 0, stdout: "state = waiting", stderr: "" };
      return ok;
    });
    io.files.set(unitPath(darwinTarget), "plist");
    expect(() => daemonUninstall(darwinTarget, io)).toThrow("may still be loaded");
    expect(io.files.has(unitPath(darwinTarget))).toBe(true);
  });

  test("darwin uninstall treats a failed query as unknown, not as proof of unload", () => {
    // Permission or IPC failures prove nothing about the job's state.
    const io = fakeIo((argv) => {
      if (argv[1] === "bootout") return { code: 5, stdout: "", stderr: "busy" };
      if (argv[1] === "print") return { code: 1, stdout: "", stderr: "Operation not permitted" };
      return ok;
    });
    io.files.set(unitPath(darwinTarget), "plist");
    expect(() => daemonUninstall(darwinTarget, io)).toThrow("may still be loaded");
    expect(io.files.has(unitPath(darwinTarget))).toBe(true);
  });

  test("darwin uninstall proceeds when the job is specifically not found", () => {
    const io = fakeIo((argv) => {
      if (argv[1] === "bootout") return { code: 3, stdout: "", stderr: "No such process" };
      if (argv[1] === "print")
        return {
          code: 113,
          stdout: "",
          stderr: 'Could not find service "ai.openomni.resident" in domain for uid: 501',
        };
      return ok;
    });
    io.files.set(unitPath(darwinTarget), "plist");
    expect(daemonUninstall(darwinTarget, io)).toContain("uninstalled");
    expect(io.files.has(unitPath(darwinTarget))).toBe(false);
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

  test("rejects a missing API key, a non-numeric port, and port 0", async () => {
    await expect(gatherOnboarding(scriptedAsk({ "Model id": "m" }))).rejects.toThrow(
      "Model API key is required",
    );
    await expect(
      gatherOnboarding(
        scriptedAsk({ "Model id": "m", "Model API key": "k", "WebSocket port": "http" }),
      ),
    ).rejects.toThrow("integer");
    await expect(
      gatherOnboarding(
        scriptedAsk({ "Model id": "m", "Model API key": "k", "WebSocket port": "0" }),
      ),
    ).rejects.toThrow("1 to 65535");
  });

  test("secret prompts are flagged so the terminal never echoes them", async () => {
    const secretQuestions: string[] = [];
    await gatherOnboarding((question, options) => {
      if (options?.secret) secretQuestions.push(question);
      if (question.startsWith("Model id")) return Promise.resolve("m");
      if (question.startsWith("Model API key")) return Promise.resolve("k");
      return Promise.resolve("");
    });
    expect(secretQuestions).toEqual([
      "Model API key",
      "Discord bot token (optional)",
      "Telegram bot token (optional)",
      "GitHub webhook secret (optional)",
    ]);
  });
});

describe("doctor", () => {
  const healthyPorts: DoctorPorts = {
    bunVersion: "1.3.0",
    envFilePresent: true,
    effectiveEnv: new Map([
      ["OPENOMNI_MODEL_PROVIDER", "anthropic"],
      ["OPENOMNI_MODEL_ID", "m"],
      ["OPENOMNI_MODEL_API_KEY", "k"],
      ["OPENOMNI_WS_PORT", "4123"],
    ]),
    unitInstalled: true,
    daemonActive: true,
    lingerEnabled: undefined,
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

  test("missing env file only warns; absent model config fails; silent health warns", async () => {
    const report = await runDoctor({
      bunVersion: "1.3.0",
      envFilePresent: false,
      effectiveEnv: new Map(),
      unitInstalled: false,
      daemonActive: false,
      lingerEnabled: undefined,
      probeHealth: () => Promise.resolve(false),
    });
    expect(report.ok).toBe(false);
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("env file")).toBe("warn");
    expect(byName.get("model config")).toBe("fail");
    expect(byName.get("daemon")).toBe("warn");
    expect(byName.get("health")).toBe("warn");
  });

  test("exported environment alone satisfies model config without an env file", async () => {
    const report = await runDoctor({
      ...healthyPorts,
      envFilePresent: false,
      unitInstalled: false,
      daemonActive: false,
    });
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("env file")).toBe("warn");
    expect(byName.get("model config")).toBe("pass");
  });

  test("a blank required value fails exactly like a missing one", async () => {
    const report = await runDoctor({
      ...healthyPorts,
      effectiveEnv: new Map([
        ["OPENOMNI_MODEL_PROVIDER", "anthropic"],
        ["OPENOMNI_MODEL_ID", "m"],
        ["OPENOMNI_MODEL_API_KEY", "   "],
      ]),
    });
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("model config")).toBe("fail");
  });

  test("installed daemon without linger warns", async () => {
    const report = await runDoctor({ ...healthyPorts, lingerEnabled: false });
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("linger")).toBe("warn");
    expect(report.ok).toBe(true);
  });

  test("active daemon with unreachable health is a failure", async () => {
    const report = await runDoctor({
      ...healthyPorts,
      effectiveEnv: new Map([["OPENOMNI_MODEL_PROVIDER", "anthropic"]]),
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
            envFilePresent: false,
            effectiveEnv: new Map<string, string>(),
            unitInstalled: false,
            daemonActive: false,
            lingerEnabled: undefined,
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

describe("processEntryPath", () => {
  test("probes bundled sibling, then compiled output, then source", () => {
    const dir = tempDir();
    const base = pathToFileURL(join(dir, "main.js")).href;
    const bundled = join(dir, "process-entry.js");
    const compiled = join(dir, "delegation", "process-entry.js");
    mkdirSync(join(dir, "delegation"), { recursive: true });
    writeFileSync(bundled, "");
    writeFileSync(compiled, "");
    expect(processEntryPath(base)).toBe(bundled);
    rmSync(bundled);
    expect(processEntryPath(base)).toBe(compiled);
    rmSync(compiled);
    expect(processEntryPath(base)).toBe(join(dir, "delegation", "process-entry.ts"));
  });
});
