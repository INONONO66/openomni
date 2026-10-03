import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { attachMachineDaemon, createMachineHost } from "../../../machines/test/helpers/native";
import { createCodemode } from "./helpers/native";

/**
 * #1275 browser recipe: Chromium runs persistently inside a cell-owned tmux
 * `pty.session`; cells reach it through the `browser(machineId)` prelude helper
 * over CDP. Everything here runs against a real tmux server on a private
 * socket and a real Chromium, so readiness and loss are decided by actual
 * terminal output, never by elapsed time.
 */
const TMUX_SOCKET = `openomni-browser-test-${process.pid}`;
const CELL_TIMEOUT_MS = 120_000;
const silent = {
  publish() {
    return;
  },
};

const sessionOf = (profile: string) =>
  `openomni-browser-${createHash("sha256").update(profile).digest("hex").slice(0, 12)}`;

/** Loud prerequisite probe: these tests must fail, not silently pass, without Chromium. */
function chromiumExecutable(): string {
  const probe = Bun.spawnSync([
    "python3",
    "-c",
    "from playwright.sync_api import sync_playwright\np = sync_playwright().start()\nprint(p.chromium.executable_path)\np.stop()",
  ]);
  const path = probe.stdout.toString("utf8").trim();
  if (probe.exitCode !== 0 || !existsSync(path)) {
    throw new Error(
      `browser recipe tests need playwright + Chromium on this host (python -m playwright install chromium): ${probe.stderr.toString("utf8").trim()}`,
    );
  }
  return path;
}

const base = mkdtempSync(join(tmpdir(), "oc-browser-"));
const outside = mkdtempSync(join(tmpdir(), "oc-browser-outside-"));
const profiles = { shared: join(base, "shared"), headed: join(base, "headed"), closing: join(base, "closing") };
const socketPath = join(tmpdir(), `oc-${crypto.randomUUID()}.sock`);
const capabilities = ["kernel.py", "pty.session"];
let mode: ReturnType<typeof createCodemode>;
let host: Awaited<ReturnType<typeof createMachineHost>>;
let daemon: Awaited<ReturnType<typeof attachMachineDaemon>>;
// The daemon-side codemode hosts the interpreter that cells actually run in;
// closing it is what ends the driver (production: daemon shutdown).
let kernelSide: ReturnType<typeof createCodemode>;

beforeAll(async () => {
  chromiumExecutable();
  for (const dir of Object.values(profiles)) mkdirSync(dir);
  host = await createMachineHost({
    listen: { unix: socketPath },
    enrollment: (id) => ({
      machineId: id,
      name: id,
      tags: [id],
      allowedExports: ["data"],
      allowedCapabilities: capabilities,
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 1,
    }),
    events: silent,
    now: () => 2,
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({ machines: host });
  kernelSide = createCodemode();
  daemon = await attachMachineDaemon({
    socketPath,
    offer: {
      machineId: "M",
      daemonVersion: "test",
      platform: `${process.platform}-${process.arch}`,
      offeredAt: 2,
      offeredCapabilities: capabilities,
      exports: [{ name: "data", path: base }],
    },
    fsExports: new Map([["data", base]]),
    runner: kernelSide.runner,
    pty: { socketName: TMUX_SOCKET },
  });
});

afterAll(async () => {
  await mode.close();
  await daemon.close();
  host.close();
  Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, "kill-server"]);
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function raisedError(result: Awaited<ReturnType<typeof mode.cell.run>>): string {
  expect(result.status).toBe("raised");
  return result.status === "raised" ? result.error : "";
}

async function listedSessions(): Promise<readonly string[]> {
  const listed = await host.get("M").pty.list();
  expect(listed.status).toBe("ok");
  return listed.status === "ok" ? listed.sessions.map((entry) => entry.name) : [];
}

test(
  "launches Chromium in a pty.session, connects over CDP, and advances past an occupied default port",
  async () => {
    // Occupying 9222 forces the documented probe-and-advance behavior; if some
    // other process already holds it the launch must advance just the same.
    let occupied: { stop(closeActiveConnections?: boolean): void } | undefined;
    try {
      occupied = Bun.listen({ hostname: "127.0.0.1", port: 9222, socket: { data() {} } });
    } catch {
      occupied = undefined;
    }
    try {
      const result = await mode.cell.run(
        [
          `client = browser("M", profile_dir=${JSON.stringify(profiles.shared)})`,
          "page = client.context.new_page()",
          'page.goto("data:text/html,<title>openomni fixture</title>")',
          "(page.title(), client.port, client.session)",
        ].join("\n"),
        "browser",
        { timeoutMs: CELL_TIMEOUT_MS },
      );
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      expect(result.value).toContain("'openomni fixture'");
      const port = Number(/, (\d+), /.exec(result.value ?? "")?.[1]);
      expect(port).toBeGreaterThan(9222);
      // The selected port is printed into and retained by the session output.
      const view = await host.get("M").pty.read(sessionOf(profiles.shared), {});
      expect(view.status).toBe("ok");
      if (view.status !== "ok") return;
      const transcript = Buffer.from(view.data).toString("utf8");
      expect(transcript).toContain(`[openomni-browser] cdp-port ${port}`);
      expect(transcript).toContain("DevTools listening on ws://");
    } finally {
      occupied?.stop(true);
    }
  },
  CELL_TIMEOUT_MS,
);

test(
  "reuses the live client for the same machine and profile instead of launching twice",
  async () => {
    const result = await mode.cell.run(
      `browser("M", profile_dir=${JSON.stringify(profiles.shared)}) is client`,
      "browser",
      { timeoutMs: CELL_TIMEOUT_MS },
    );
    expect(result).toMatchObject({ status: "completed", value: "True" });
    expect(await listedSessions()).toEqual([sessionOf(profiles.shared)]);
  },
  CELL_TIMEOUT_MS,
);

test(
  "a Chromium killed behind the client's back surfaces browser_lost with the terminal transcript",
  async () => {
    // Stop Chromium behind the client's back via the pid retained in the
    // session output (this build ignores CDP Browser.close and hangup signals).
    const view = await host.get("M").pty.read(sessionOf(profiles.shared), {});
    expect(view.status).toBe("ok");
    const transcript = view.status === "ok" ? Buffer.from(view.data).toString("utf8") : "";
    const pid = Number(/\[openomni-browser\] chromium-pid (\d+)/.exec(transcript)?.[1]);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    // Loss detection is a liveness round trip inside every client accessor, so
    // the very next operation surfaces the typed refusal deterministically.
    const error = raisedError(await mode.cell.run("client.pages", "browser", { timeoutMs: CELL_TIMEOUT_MS }));
    expect(error).toContain("browser_lost");
    expect(error).toContain("--- tmux session output ---");
    expect(error).toContain("[openomni-browser] cdp-port");
  },
  CELL_TIMEOUT_MS,
);

test.if(process.platform === "darwin" || Boolean(process.env["DISPLAY"]))(
  "headless=False launches a headed Chromium and close() ends its session",
  async () => {
    const result = await mode.cell.run(
      [
        `headed = browser("M", headless=False, profile_dir=${JSON.stringify(profiles.headed)})`,
        "connected = headed.is_connected()",
        "headed.close()",
        "connected",
      ].join("\n"),
      "browser",
      { timeoutMs: CELL_TIMEOUT_MS },
    );
    expect(result).toMatchObject({ status: "completed", value: "True" });
    expect(await listedSessions()).not.toContain(sessionOf(profiles.headed));
  },
  CELL_TIMEOUT_MS,
);

test(
  "a profile_dir outside every export refuses with path_escapes_export before Chromium starts",
  async () => {
    const error = raisedError(
      await mode.cell.run(`browser("M", profile_dir=${JSON.stringify(join(outside, "profile"))})`, "browser", {
        timeoutMs: CELL_TIMEOUT_MS,
      }),
    );
    expect(error).toContain("path_escapes_export");
    expect(await listedSessions()).not.toContain(sessionOf(join(outside, "profile")));
  },
  CELL_TIMEOUT_MS,
);

test(
  "a missing Chromium executable refuses typed and tears the owned session down (4b)",
  async () => {
    const error = raisedError(
      await mode.cell.run(
        [
          "try:",
          `    browser("M", profile_dir=${JSON.stringify(profiles.closing)}, executable_path="/nonexistent/chromium")`,
          "except BrowserLost as lost:",
          "    raise lost",
        ].join("\n"),
        "browser",
        { timeoutMs: CELL_TIMEOUT_MS },
      ),
    );
    expect(error).toContain("browser_lost");
    expect(error).toContain("/nonexistent/chromium");
    expect(error).toContain("python -m playwright install chromium");
    expect(await listedSessions()).not.toContain(sessionOf(profiles.closing));
    const direct = Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, "ls"]);
    expect(direct.stdout.toString("utf8")).not.toContain(sessionOf(profiles.closing));
  },
  CELL_TIMEOUT_MS,
);

test(
  "closing the interpreter ends Chromium and its tmux session without deleting the profile",
  async () => {
    const launched = await mode.cell.run(
      `browser("M", profile_dir=${JSON.stringify(profiles.closing)}).is_connected()`,
      "browser",
      { timeoutMs: CELL_TIMEOUT_MS },
    );
    expect(launched).toMatchObject({ status: "completed", value: "True" });
    const session = sessionOf(profiles.closing);
    expect(await listedSessions()).toContain(session);
    const view = await host.get("M").pty.read(session, {});
    expect(view.status).toBe("ok");
    const transcript = view.status === "ok" ? Buffer.from(view.data).toString("utf8") : "";
    const pid = Number(/\[openomni-browser\] chromium-pid (\d+)/.exec(transcript)?.[1]);
    expect(pid).toBeGreaterThan(0);
    let cursor = view.status === "ok" ? view.cursor : undefined;
    await kernelSide.close();
    // The driver's EOF cleanup runs before the interpreter exits, so once
    // close() resolves the browser process is already stopped.
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    // The shell observes the signal-range status and exits the session itself;
    // cursor long-polls pace the bounded wait on that tmux-internal hand-off.
    const sessionListed = () =>
      Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, "has-session", "-t", `=${session}`]).exitCode === 0;
    let listed = sessionListed();
    for (let round = 0; round < 30 && listed; round += 1) {
      const paced = await host.get("M").pty.read(session, { ...(cursor ? { cursor } : {}), waitMs: 1_000 });
      if (paced.status === "ok") cursor = paced.cursor;
      listed = sessionListed();
    }
    expect(listed).toBe(false);
    expect(existsSync(profiles.closing)).toBe(true);
  },
  CELL_TIMEOUT_MS,
);
