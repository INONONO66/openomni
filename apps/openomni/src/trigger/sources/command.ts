import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Trigger } from "@openomni/protocol";
import { sanitizeSourceText } from "../notifier";

type EventSourceTerminalReason = Extract<
  Trigger.TerminalFireReason,
  "cancelled" | "source_exited" | "source_timeout" | "source_error"
>;

export interface EventSourceSink {
  line(text: string, at: number): void | Promise<void>;
  terminal(input: {
    readonly reason: EventSourceTerminalReason | "completed";
    /** Optional priority line delivered atomically with a terminal summary (file match). */
    readonly line?: string;
    readonly summary: string;
    readonly at: number;
    readonly detail?: string;
  }): void | Promise<void>;
}

interface CommandSourceClock {
  now(): number;
}

export interface CommandSourceChild {
  readonly pid?: number;
  readonly stdout: {
    on(event: "data" | "error", listener: (value: unknown) => void): unknown;
  };
  readonly stderr: {
    on(event: "data" | "error", listener: (value: unknown) => void): unknown;
  };
  once(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

interface CommandSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly detached: true;
  readonly stdio: ["ignore", "pipe", "pipe"];
}

export type CommandSpawn = (
  shell: string,
  args: readonly ["-lc", string],
  options: CommandSpawnOptions,
) => CommandSourceChild;

export interface GraceTimerPort {
  arm(delayMs: number, callback: () => void): () => void;
}

const nativeGraceTimer: GraceTimerPort = {
  arm(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    const unref = (handle as unknown as { unref?: () => void }).unref;
    unref?.call(handle);
    return () => clearTimeout(handle);
  },
};

export interface CommandSourceDeps {
  readonly clock: CommandSourceClock;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: string;
  readonly spawn?: CommandSpawn;
  readonly signalGroup?: (groupLeaderPid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly graceTimer?: GraceTimerPort;
  readonly onError?: (error: unknown) => void;
}

export interface PreparedCommandSource {
  readonly command: string;
  readonly filter?: RegExp;
  readonly shell: string;
  readonly persistent: boolean;
}

export interface CommandSourceHandle {
  /** Wake-budget suppression keeps draining the pipe but drops ordinary lines. */
  pause(): void;
  resume(): void;
  /** Durable cancellation/timeout must be recorded by the sink before signaling. */
  cancel(reason: "cancelled" | "source_timeout"): Promise<void>;
  /** Host shutdown owns cleanup only and emits no lifecycle observation. */
  stop(): Promise<void>;
  readonly done: Promise<void>;
}

class CommandSourceRefusal extends Error {
  constructor(
    readonly code:
      | "command_invalid"
      | "filter_invalid"
      | "source_unavailable"
      | "source_spawn"
      | "source_pipe",
    message: string,
  ) {
    super(message);
    this.name = "CommandSourceRefusal";
  }
}

function executableShell(shell: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(shell);
    accessSync(shell, fsConstants.X_OK);
  } catch (error) {
    throw new CommandSourceRefusal(
      "source_unavailable",
      `Trigger command shell is unavailable: ${shell} — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!stat.isFile()) {
    throw new CommandSourceRefusal(
      "source_unavailable",
      `Trigger command shell is not an executable file: ${shell}`,
    );
  }
}

/** Pure-effect preflight: validates every refusal that must precede row creation. */
export function preflightCommandSource(
  source: Extract<Trigger.Source, { kind: "event.command" }>,
  deps: Pick<CommandSourceDeps, "env" | "shell"> = {},
): PreparedCommandSource {
  const command = source.command.trim();
  if (command.length === 0 || command.includes("\0")) {
    throw new CommandSourceRefusal(
      "command_invalid",
      "Trigger command must be non-empty and contain no NUL byte",
    );
  }
  if (command.length > Trigger.Constants.MAX_COMMAND_CHARS) {
    throw new CommandSourceRefusal(
      "command_invalid",
      `Trigger command exceeds ${Trigger.Constants.MAX_COMMAND_CHARS} characters`,
    );
  }
  let filter: RegExp | undefined;
  if (source.filter !== undefined) {
    try {
      filter = new RegExp(source.filter);
    } catch (error) {
      throw new CommandSourceRefusal(
        "filter_invalid",
        `Trigger command filter is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const shell = deps.shell ?? deps.env?.SHELL?.trim() ?? process.env.SHELL?.trim() ?? "/bin/sh";
  if (shell.length === 0 || shell.includes("\0")) {
    throw new CommandSourceRefusal("source_unavailable", "Trigger command shell is invalid");
  }
  executableShell(shell);
  return {
    command,
    ...(filter === undefined ? {} : { filter }),
    shell,
    persistent: source.persistent,
  };
}

function defaultSpawn(
  shell: string,
  args: readonly ["-lc", string],
  options: CommandSpawnOptions,
): CommandSourceChild {
  return nodeSpawn(shell, [...args], options) as unknown as CommandSourceChild;
}

function defaultSignalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Starts the post-commit command effect in its own process group. */
export function startCommandSource(
  prepared: PreparedCommandSource,
  sink: EventSourceSink,
  deps: CommandSourceDeps,
): CommandSourceHandle {
  const spawn = deps.spawn ?? defaultSpawn;
  const signalGroup = deps.signalGroup ?? defaultSignalGroup;
  const graceTimer = deps.graceTimer ?? nativeGraceTimer;
  const command = `exec 2>&1\n${prepared.command}`;

  let child: CommandSourceChild;
  try {
    child = spawn(prepared.shell, ["-lc", command], {
      cwd: deps.cwd,
      env: deps.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CommandSourceRefusal(
      "source_spawn",
      `Trigger command did not start: ${errorText(error)}`,
    );
  }
  const spawnedPid = child.pid;
  if (spawnedPid === undefined || !Number.isSafeInteger(spawnedPid) || spawnedPid <= 0) {
    throw new CommandSourceRefusal(
      "source_spawn",
      "Trigger command did not establish a process-group leader",
    );
  }
  // Bound after the guard so the group-signalling closures below see a pid that
  // is known present rather than re-narrowing an optional on every use.
  const pid: number = spawnedPid;

  const decoder = new StringDecoder("utf8");
  let partial = "";
  let clipping = false;
  let paused = false;
  let terminalClaimed = false;
  let shutdown = false;
  let closed = false;
  let serial = Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function report(error: unknown): void {
    deps.onError?.(error);
  }

  function enqueue(operation: () => void | Promise<void>): Promise<void> {
    const next = serial.then(operation);
    serial = next.catch(report);
    return next;
  }

  function acceptedLine(line: string): void {
    if (paused || terminalClaimed || shutdown) return;
    const sanitized = sanitizeSourceText(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (sanitized === undefined || (prepared.filter !== undefined && !prepared.filter.test(sanitized))) {
      return;
    }
    const at = deps.clock.now();
    void enqueue(() => sink.line(sanitized, at));
  }

  function consumeDecoded(decoded: string): void {
    let start = 0;
    for (let index = 0; index < decoded.length; index += 1) {
      if (decoded.charCodeAt(index) !== 10) continue;
      const segment = decoded.slice(start, index);
      if (!clipping) {
        partial += segment;
      }
      acceptedLine(partial);
      partial = "";
      clipping = false;
      start = index + 1;
    }
    if (start >= decoded.length) return;
    const tail = decoded.slice(start);
    if (clipping) return;
    const available = Trigger.Constants.MAX_PARTIAL_LINE_CHARS - partial.length;
    if (tail.length <= available) {
      partial += tail;
      return;
    }
    partial += tail.slice(0, Math.max(0, available));
    clipping = true;
  }

  function terminal(
    reason: EventSourceTerminalReason,
    summary: string,
    detail?: string,
  ): Promise<boolean> {
    if (terminalClaimed || shutdown) return Promise.resolve(false);
    terminalClaimed = true;
    const sanitizedSummary = sanitizeSourceText(summary) ?? "source closed";
    const sanitizedDetail =
      detail === undefined
        ? undefined
        : (sanitizeSourceText(detail)?.slice(0, Trigger.Constants.MAX_DETAIL_CHARS) ??
          reason);
    return enqueue(() =>
      sink.terminal({
        reason,
        summary: sanitizedSummary,
        at: deps.clock.now(),
        ...(sanitizedDetail === undefined ? {} : { detail: sanitizedDetail }),
      }),
    ).then(() => true);
  }

  function pipeFault(code: "source_pipe" | "source_spawn", error: unknown): void {
    void terminal("source_error", `${code}: command source failed`, code).then((won) => {
      if (won) void terminateGroup();
    });
    report(error);
  }

  function waitForGrace(): Promise<"closed" | "elapsed"> {
    if (closed) return Promise.resolve("closed");
    return new Promise((resolve) => {
      const cancel = graceTimer.arm(Trigger.Constants.SOURCE_KILL_GRACE_MS, () => {
        resolve("elapsed");
      });
      void done.then(() => {
        cancel();
        resolve("closed");
      });
    });
  }

  let terminating: Promise<void> | undefined;
  function terminateGroup(): Promise<void> {
    if (terminating !== undefined) return terminating;
    terminating = (async () => {
      try {
        signalGroup(pid, "SIGTERM");
      } catch (error) {
        report(error);
      }
      if ((await waitForGrace()) === "elapsed") {
        try {
          signalGroup(pid, "SIGKILL");
        } catch (error) {
          report(error);
        }
      }
    })();
    return terminating;
  }

  child.stdout.on("data", (value) => {
    if (shutdown || terminalClaimed) return;
    const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value));
    consumeDecoded(decoder.write(bytes));
  });
  child.stdout.on("error", (error) => pipeFault("source_pipe", error));
  child.stderr.on("data", (value) => {
    const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value));
    if (bytes.byteLength > 0) pipeFault("source_pipe", new Error("unexpected stderr bytes"));
  });
  child.stderr.on("error", (error) => pipeFault("source_pipe", error));
  child.once("error", (error) => pipeFault("source_spawn", error));
  child.once("close", (code, signal) => {
    closed = true;
    // Flush decoder state only to release its internal bytes. A final partial
    // line is intentionally discarded; complete lines were framed above.
    decoder.end();
    partial = "";
    resolveDone();
    if (shutdown || terminalClaimed) return;
    const status = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
    void terminal("source_exited", `command source exited (${status})`);
  });

  return {
    pause() {
      paused = true;
    },
    resume() {
      if (!terminalClaimed && !shutdown) paused = false;
    },
    async cancel(reason) {
      const summary =
        reason === "cancelled" ? "command source cancelled" : "command source timed out";
      const won = await terminal(reason, summary);
      if (won) await terminateGroup();
    },
    async stop() {
      if (shutdown) return terminating;
      shutdown = true;
      terminalClaimed = true;
      await terminateGroup();
    },
    done,
  };
}
