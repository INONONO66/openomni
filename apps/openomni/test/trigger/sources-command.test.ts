import { describe, expect, test } from "bun:test";
import {
  startCommandSource,
  type CommandSourceChild,
  type CommandSpawn,
  type EventSourceSink,
  type GraceTimerPort,
  type PreparedCommandSource,
} from "../../src/trigger/sources/command";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeStream {
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  on(event: "data" | "error", listener: (value: unknown) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: "data" | "error", value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

class FakeChild implements CommandSourceChild {
  readonly pid = 4242;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  private readonly listeners = new Map<string, Array<(...values: unknown[]) => void>>();

  once(event: "close" | "error", listener: (...values: never[]) => void): this {
    this.listeners.set(event, [listener as (...values: unknown[]) => void]);
    return this;
  }

  close(code: number | null = 0, signal: string | null = null): void {
    for (const listener of this.listeners.get("close") ?? []) listener(code, signal);
  }

  fail(error: Error): void {
    for (const listener of this.listeners.get("error") ?? []) listener(error);
  }
}

const PREPARED: PreparedCommandSource = {
  command: "printf hello",
  shell: "/bin/sh",
  persistent: false,
};

function commandRig(options: { filter?: RegExp; onTerminal?: () => void } = {}) {
  const child = new FakeChild();
  const spawnCalls: unknown[][] = [];
  const spawn: CommandSpawn = (...args) => {
    spawnCalls.push(args);
    return child;
  };
  const lines: Array<{ text: string; at: number }> = [];
  const terminals: Parameters<EventSourceSink["terminal"]>[0][] = [];
  const terminal = deferred<void>();
  const sink: EventSourceSink = {
    line(text, at) {
      lines.push({ text, at });
    },
    terminal(input) {
      terminals.push(input);
      options.onTerminal?.();
      terminal.resolve();
    },
  };
  const handle = startCommandSource(
    { ...PREPARED, ...(options.filter === undefined ? {} : { filter: options.filter }) },
    sink,
    {
      clock: { now: () => 7_000 },
      cwd: "/work",
      env: { PATH: "/bin" },
      spawn,
    },
  );
  return { child, spawnCalls, lines, terminals, terminal, handle };
}

describe("command Trigger source", () => {
  test("uses the exact detached shell command and one merged output pipe", () => {
    const rig = commandRig();
    expect(rig.spawnCalls).toEqual([
      [
        "/bin/sh",
        ["-lc", "exec 2>&1\nprintf hello"],
        {
          cwd: "/work",
          env: { PATH: "/bin" },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ],
    ]);
  });

  test("decodes split UTF-8, frames CRLF, filters, and emits exit after queued lines", async () => {
    const rig = commandRig({ filter: /€|keep/ });
    const euro = Buffer.from("€");
    rig.child.stdout.emit("data", euro.subarray(0, 2));
    rig.child.stdout.emit("data", Buffer.concat([euro.subarray(2), Buffer.from("\r\ndrop\nkeep\n")]));
    rig.child.close(3);

    await rig.terminal.promise;
    expect(rig.lines).toEqual([
      { text: "€", at: 7_000 },
      { text: "keep", at: 7_000 },
    ]);
    expect(rig.terminals).toEqual([
      { reason: "source_exited", summary: "command source exited (exit code 3)", at: 7_000 },
    ]);
  });

  test("discards a final partial line and paused complete lines without backing up the pipe", async () => {
    const rig = commandRig();
    rig.handle.pause();
    rig.child.stdout.emit("data", Buffer.from("paused\n"));
    rig.handle.resume();
    rig.child.stdout.emit("data", Buffer.from("accepted\nunfinished"));
    rig.child.close(0);

    await rig.terminal.promise;
    expect(rig.lines).toEqual([{ text: "accepted", at: 7_000 }]);
  });

  test("caps a newline-free line and never grows the retained prefix", async () => {
    const rig = commandRig();
    rig.child.stdout.emit("data", Buffer.from("x".repeat(10_000)));
    rig.child.stdout.emit("data", Buffer.from("more-discarded\n"));
    rig.child.close(0);

    await rig.terminal.promise;
    expect(rig.lines).toHaveLength(1);
    expect(rig.lines[0]?.text).toBe("x".repeat(1_024));
  });

  test("unexpected stderr is a typed terminal pipe fault", async () => {
    const signals: string[] = [];
    const child = new FakeChild();
    const terminal = deferred<Parameters<EventSourceSink["terminal"]>[0]>();
    // A pipe fault commits its terminal summary and THEN tears the group down,
    // so the group signal is the last observable step of the fault.
    const signalled = deferred<void>();
    startCommandSource(PREPARED, {
      line: () => undefined,
      terminal(input) {
        terminal.resolve(input);
      },
    }, {
      clock: { now: () => 9_000 },
      cwd: "/work",
      spawn: () => child,
      signalGroup: (_pid, signal) => {
        signals.push(signal);
        child.close(null, signal);
        signalled.resolve();
      },
    });

    child.stderr.emit("data", Buffer.from("should have been merged"));

    expect(await terminal.promise).toEqual({
      reason: "source_error",
      summary: "source_pipe: command source failed",
      at: 9_000,
      detail: "source_pipe",
    });
    await signalled.promise;
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("cancellation commits its summary before signaling the process group", async () => {
    const order: string[] = [];
    const child = new FakeChild();
    const handle = startCommandSource(PREPARED, {
      line: () => undefined,
      terminal() {
        order.push("terminal");
      },
    }, {
      clock: { now: () => 1 },
      cwd: "/work",
      spawn: () => child,
      signalGroup: (_pid, signal) => {
        order.push(signal);
        child.close(null, signal);
      },
    });

    await handle.cancel("cancelled");

    expect(order).toEqual(["terminal", "SIGTERM"]);
  });

  test("timeout escalates through an injected exact grace signal, without a sleep", async () => {
    const child = new FakeChild();
    let graceCallback: (() => void) | undefined;
    // Resolves the instant the grace window is armed, which is exactly the point
    // where SIGTERM has been sent and SIGKILL has not.
    const armed = deferred<void>();
    const graceTimer: GraceTimerPort = {
      arm(_delay, callback) {
        graceCallback = callback;
        armed.resolve();
        return () => undefined;
      },
    };
    const signals: string[] = [];
    const handle = startCommandSource(PREPARED, {
      line: () => undefined,
      terminal: () => undefined,
    }, {
      clock: { now: () => 1 },
      cwd: "/work",
      spawn: () => child,
      graceTimer,
      signalGroup: (_pid, signal) => signals.push(signal),
    });

    const cancelled = handle.cancel("source_timeout");
    await armed.promise;
    expect(signals).toEqual(["SIGTERM"]);
    if (graceCallback === undefined) throw new Error("kill grace was not armed");
    graceCallback();
    await cancelled;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
