import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Machine } from "@openomni/protocol";
import { systemCommandRunner } from "../src/commands";
import { MachinesFailure } from "../src/errors";
import { createPtyAdapter, type PtyAdapter } from "../src/pty";
import type { PtyControl, PtyControlFactory } from "../src/pty-control";
import { run } from "./ipc/helpers/effects";

/**
 * Real-tmux adapter tests (#1273) on a private `-L` socket so the Owner's own
 * tmux server is never touched. The server started here is killed in afterAll.
 */
const SOCKET = `openomni-test-${process.pid}`;
const CONTROL_SESSION = "omo-pty-control";

const tmuxCli = (...args: string[]) => Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { stderr: "pipe" });

afterAll(() => {
  tmuxCli("kill-server");
});

async function openAdapter(generation: string): Promise<PtyAdapter> {
  const adapter = createPtyAdapter({ id: () => generation, runner: systemCommandRunner(), socketName: SOCKET });
  expect(await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]))).toEqual([
    Machine.WellKnownCapability.ptySession,
  ]);
  return adapter;
}

function okOpen(result: Machine.PtyOpenResult): Extract<Machine.PtyOpenResult, { status: "ok" }> {
  if (result.status !== "ok") throw new Error(`open refused: ${result.reason}`);
  return result;
}

function okRead(result: Machine.PtyReadResult): Extract<Machine.PtyReadResult, { status: "ok" }> {
  if (result.status !== "ok") throw new Error(`read refused: ${result.reason}`);
  return result;
}

async function writeText(adapter: PtyAdapter, name: string, text: string): Promise<void> {
  const written = await run(adapter.write({ name, data: Buffer.from(text, "utf8").toString("base64") }));
  expect(written).toEqual({ status: "ok" });
}

/** Event-driven drain: every round blocks on the adapter's long-poll, no sleeps. */
async function readUntil(adapter: PtyAdapter, name: string, cursor: string, marker: string, rounds = 200) {
  let seen = "";
  let at = cursor;
  for (let round = 0; round < rounds && !seen.includes(marker); round += 1) {
    const view = okRead(await run(adapter.read({ name, cursor: at, waitMs: 2000 })));
    seen += Buffer.from(view.data, "base64").toString("utf8");
    at = view.cursor;
  }
  expect(seen).toContain(marker);
  return { seen, cursor: at };
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("pty.session over real tmux", () => {
  test("open creates one detached named session, same-name open reattaches, close kills only that session", async () => {
    const adapter = await openAdapter("gen-lifecycle");
    okOpen(await run(adapter.open({ name: "alpha", cwd: "/" })));
    expect(tmuxCli("has-session", "-t", "=alpha").exitCode).toBe(0);
    // Detached: no client is attached to the named session itself.
    expect(tmuxCli("list-clients", "-t", "=alpha").stdout.toString()).toBe("");
    okOpen(await run(adapter.open({ name: "alpha", cwd: "/" })));
    const named = tmuxCli("list-sessions", "-F", "#{session_name}").stdout.toString().split("\n");
    expect(named.filter((name) => name === "alpha")).toHaveLength(1);
    okOpen(await run(adapter.open({ name: "omega", cwd: "/" })));
    const listed = await run(adapter.list({}));
    if (listed.status !== "ok") throw new Error(`list refused: ${listed.reason}`);
    expect(listed.sessions).toEqual([
      { name: "alpha", status: "live" },
      { name: "omega", status: "live" },
    ]);
    expect(listed.truncated).toBe(false);
    // The reserved control session is never a user terminal.
    expect(await run(adapter.open({ name: CONTROL_SESSION, cwd: "/" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    expect(await run(adapter.close({ name: "omega" }))).toEqual({ status: "ok" });
    expect(tmuxCli("has-session", "-t", "=omega").exitCode).not.toBe(0);
    expect(tmuxCli("has-session", "-t", "=alpha").exitCode).toBe(0);
    expect(await run(adapter.read({ name: "omega" }))).toEqual({ status: "refused", reason: "pty_not_found" });
    await run(adapter.close({ name: "alpha" }));
    await run(adapter.shutdown());
  }, 30_000);

  test("replay and live output share one cursor with no duplicate bytes across a daemon restart", async () => {
    const first = await openAdapter("gen-one");
    const opened = okOpen(await run(first.open({ name: "beta", cwd: "/" })));
    await writeText(first, "beta", "printf 'pre-%s\\n' marker\r");
    const before = await readUntil(first, "beta", opened.cursor, "pre-marker");
    // Live decode delivered the printf result exactly once (the typed command
    // line echoes as `printf 'pre-%s\n' marker`, which never matches).
    expect(count(before.seen, "pre-marker")).toBe(1);
    // Daemon dies, tmux server lives: only the control client goes away.
    await run(first.shutdown());
    expect(tmuxCli("has-session", "-t", "=beta").exitCode).toBe(0);

    const second = await openAdapter("gen-two");
    const reopened = okOpen(await run(second.open({ name: "beta", cwd: "/" })));
    // Scrollback replay: a fresh cursor replays retained history exactly once.
    const replayed = okRead(await run(second.read({ name: "beta", cursor: reopened.cursor })));
    const replay = Buffer.from(replayed.data, "base64").toString("utf8");
    expect(count(replay, "pre-marker")).toBe(1);
    // A cursor minted by the previous daemon generation resumes AFTER the
    // snapshot: the next read returns exactly the subsequent output.
    await writeText(second, "beta", "printf 'post-%s\\n' marker\r");
    const after = await readUntil(second, "beta", before.cursor, "post-marker");
    expect(after.seen).not.toContain("pre-marker");
    expect(count(after.seen, "post-marker")).toBe(1);
    await run(second.close({ name: "beta" }));
    await run(second.shutdown());
  }, 30_000);

  test("resize changes the dimensions the shell observes", async () => {
    const adapter = await openAdapter("gen-resize");
    const opened = okOpen(await run(adapter.open({ name: "gamma", cwd: "/" })));
    await writeText(adapter, "gamma", "stty size\r");
    const initial = await readUntil(adapter, "gamma", opened.cursor, "24 80");
    expect(await run(adapter.resize({ name: "gamma", cols: 120, rows: 40 }))).toEqual({ status: "ok" });
    await writeText(adapter, "gamma", "stty size\r");
    await readUntil(adapter, "gamma", initial.cursor, "40 120");
    await run(adapter.close({ name: "gamma" }));
    await run(adapter.shutdown());
  }, 30_000);

  test("over-cap output returns the bounded suffix, truncated:true, and a cursor past all observed bytes", async () => {
    const adapter = await openAdapter("gen-cap");
    const opened = okOpen(await run(adapter.open({ name: "flood", cwd: "/" })));
    await writeText(adapter, "flood", "yes | head -c 300000; printf 'FLOOD-%s\\n' done\r");
    // A fast producer wakes each long-poll with one arrival's worth of bytes;
    // draining 300000+ bytes therefore takes many immediate rounds.
    await readUntil(adapter, "flood", opened.cursor, "FLOOD-done", 1000);
    // One read over the whole retained stream crosses the response cap.
    const capped = okRead(await run(adapter.read({ name: "flood" })));
    expect(capped.truncated).toBe(true);
    expect(Buffer.from(capped.data, "base64").length).toBe(Machine.PTY_READ_MAX_BYTES);
    // The cursor advanced past everything observed: nothing loops back.
    const drained = okRead(await run(adapter.read({ name: "flood", cursor: capped.cursor })));
    expect(drained.data).toBe("");
    expect(drained.truncated).toBe(false);
    await run(adapter.close({ name: "flood" }));
    await run(adapter.shutdown());
  }, 40_000);

  test("tmux server death marks sessions lost, fails operations deterministically, and withdraws the capability until the next attach probe", async () => {
    const adapter = await openAdapter("gen-loss");
    const opened = okOpen(await run(adapter.open({ name: "delta", cwd: "/" })));
    // A read that outlives the server settles as a typed refusal, never hangs.
    const pending = run(adapter.read({ name: "delta", cursor: opened.cursor, waitMs: 10_000 }));
    expect(tmuxCli("kill-server").exitCode).toBe(0);
    expect(await pending).toEqual({ status: "refused", reason: "pty_not_available" });
    expect(await run(adapter.list({}))).toEqual({ status: "refused", reason: "pty_not_available" });
    expect(await run(adapter.open({ name: "delta", cwd: "/" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    expect(await run(adapter.write({ name: "delta", data: "" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    // The next attach probes PATH again and restores the offer; sessions from
    // the dead server are gone, not silently recreated.
    expect(await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]))).toEqual([
      Machine.WellKnownCapability.ptySession,
    ]);
    expect(await run(adapter.read({ name: "delta" }))).toEqual({ status: "refused", reason: "pty_not_found" });
    await run(adapter.shutdown());
  }, 30_000);

  test("a missing tmux binary withholds the capability and every call refuses pty_not_available", async () => {
    const adapter = createPtyAdapter({
      id: () => "gen-missing",
      runner: systemCommandRunner(),
      tmux: "openomni-test-no-such-tmux",
      socketName: SOCKET,
    });
    expect(await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession, "shell.exec"]))).toEqual([
      "shell.exec",
    ]);
    expect(await run(adapter.open({ name: "nope", cwd: "/" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    await run(adapter.shutdown());
  });
});

describe("pty.session control-stream faults (scripted server)", () => {
  function scripted() {
    const names: string[] = [];
    const lines: string[] = [];
    let hooks: Parameters<PtyControlFactory>[0] | undefined;
    const control: PtyControl = {
      command: (line) =>
        Effect.sync(() => {
          lines.push(line);
          if (line.startsWith("list-sessions")) return [...names];
          if (line.startsWith("new-session")) {
            names.push(line.split(" ")[3] ?? "");
            return [];
          }
          if (line.startsWith("list-panes")) return ["@9 %9"];
          if (line.startsWith("capture-pane")) return ["snapshot"];
          if (line.startsWith("kill-session")) {
            names.length = 0;
            return [];
          }
          return [];
        }),
      close: () => Effect.void,
    };
    const adapter = createPtyAdapter({
      id: () => "gen-scripted",
      runner: { run: () => Effect.succeed({ exitCode: 0, stdout: "tmux 3.7c", stderr: "" }) },
      control: (options) => {
        hooks = options;
        return Effect.succeed(control);
      },
    });
    const faults = () => {
      if (hooks === undefined) throw new Error("control client never started");
      return hooks;
    };
    return { adapter, faults, lines };
  }

  // CI runs tmux 3.4 (ubuntu-24.04) while this Mac runs 3.7: the adapter may
  // only speak the 3.4 grammar. This pins every command line the adapter can
  // issue — no 3.5+ control-mode flow control (pause-after, refresh-client -A),
  // no client flags on attach, literal-byte writes as hex send-keys.
  test("the adapter's tmux command grammar stays within the tmux 3.4 flag set", async () => {
    const { adapter, faults, lines } = scripted();
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    const opened = okOpen(await run(adapter.open({ name: "zeta", cwd: "/tmp" })));
    okRead(await run(adapter.read({ name: "zeta", cursor: opened.cursor })));
    await run(adapter.write({ name: "zeta", data: Buffer.from("hi\n", "utf8").toString("base64") }));
    expect(await run(adapter.resize({ name: "zeta", cols: 100, rows: 30 }))).toEqual({ status: "ok" });
    expect(await run(adapter.list({}))).toEqual({
      status: "ok",
      sessions: [{ name: "zeta", status: "live" }],
      truncated: false,
    });
    expect(await run(adapter.close({ name: "zeta" }))).toEqual({ status: "ok" });
    // The control client attaches with -C (a daemon has no tty for -CC) and
    // -A so a daemon restart reattaches the reserved control session.
    expect(faults().argv).toEqual(["tmux", "-C", "new-session", "-A", "-s", "omo-pty-control"]);
    expect(lines).toEqual([
      'list-sessions -F "#{session_name}"',
      'list-sessions -F "#{session_name}"',
      'new-session -d -s zeta -c "/tmp" -x 80 -y 24',
      'list-panes -t =zeta: -F "#{window_id} #{pane_id}"',
      "link-window -s @9 -t omo-pty-control:",
      "capture-pane -p -t %9 -S - -E -",
      "send-keys -t %9 -H 68 69 0a",
      "set-option -w -t =zeta: window-size manual",
      "resize-window -t =zeta: -x 100 -y 30",
      'list-sessions -F "#{session_name}"',
      "kill-session -t =zeta",
      "kill-window -t @9",
    ]);
  });

  test("a malformed control record fails exactly the next read of the affected pane, then streaming resumes", async () => {
    const { adapter, faults } = scripted();
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    const opened = okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    const replay = okRead(await run(adapter.read({ name: "zeta", cursor: opened.cursor })));
    expect(Buffer.from(replay.data, "base64").toString("utf8")).toBe("snapshot\n");
    faults().onOutput("%9", Buffer.from("live-1\n"));
    const live = okRead(await run(adapter.read({ name: "zeta", cursor: replay.cursor })));
    expect(Buffer.from(live.data, "base64").toString("utf8")).toBe("live-1\n");
    faults().onMalformed("%9", "bad octal escape");
    await expect(run(adapter.read({ name: "zeta", cursor: live.cursor }))).rejects.toMatchObject({
      _tag: "MachinesFailure",
      operation: "pty.read",
      cause: "malformed tmux control output: bad octal escape",
    });
    const resumed = okRead(await run(adapter.read({ name: "zeta", cursor: live.cursor })));
    expect(resumed.data).toBe("");
    // An unattributable record cannot name a pane: every session is poisoned.
    faults().onMalformed(undefined, "unframed record");
    const poisoned = await run(Effect.result(adapter.read({ name: "zeta" })));
    expect(poisoned._tag === "Failure" && poisoned.failure instanceof MachinesFailure).toBe(true);
  });

  test("closing a session settles its blocked long-poll read as pty_not_found while the capability stays live", async () => {
    const { adapter } = scripted();
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    const opened = okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    const replay = okRead(await run(adapter.read({ name: "zeta", cursor: opened.cursor })));
    const blocked = run(adapter.read({ name: "zeta", cursor: replay.cursor, waitMs: 10_000 }));
    expect(await run(adapter.close({ name: "zeta" }))).toEqual({ status: "ok" });
    expect(await blocked).toEqual({ status: "refused", reason: "pty_not_found" });
  });

  test("control client exit marks every session lost until a fresh probe", async () => {
    const { adapter, faults } = scripted();
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    faults().onExit();
    expect(await run(adapter.read({ name: "zeta" }))).toEqual({ status: "refused", reason: "pty_not_available" });
  });
});
