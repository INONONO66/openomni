import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  watch as nodeWatch,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Trigger } from "@openomni/protocol";
import { sanitizeSourceText } from "../notifier";
import type { EventSourceSink } from "./command";

export interface FileStat {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly regular: boolean;
  readonly symlink: boolean;
}

interface FileWatchHandle {
  close(): void;
}

export interface FileSystemPort {
  realpath(path: string): string;
  lstat(path: string): FileStat;
  openNoFollow(path: string): unknown;
  fstat(handle: unknown): FileStat;
  read(handle: unknown, offset: number, length: number): Uint8Array;
  close(handle: unknown): void;
  watch(
    parent: string,
    onChange: (filename: string | null) => void,
    onError: (error: unknown) => void,
  ): FileWatchHandle;
}

interface FilePollPort {
  arm(delayMs: number, callback: () => void): () => void;
}

const nativePollPort: FilePollPort = {
  arm(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    const unref = (handle as unknown as { unref?: () => void }).unref;
    unref?.call(handle);
    return () => clearTimeout(handle);
  },
};

function nativeStat(path: string): FileStat {
  const stat = lstatSync(path);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    regular: stat.isFile(),
    symlink: stat.isSymbolicLink(),
  };
}

const nativeFileSystem: FileSystemPort = {
  realpath: realpathSync,
  lstat: nativeStat,
  openNoFollow(path) {
    const noFollow = fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== "number" || noFollow === 0) {
      throw new FileSourceRefusal(
        "source_identity",
        "The platform cannot open Trigger files without following symlinks",
      );
    }
    return openSync(path, fsConstants.O_RDONLY | noFollow);
  },
  fstat(handle) {
    const stat = fstatSync(handle as number);
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      regular: stat.isFile(),
      symlink: stat.isSymbolicLink(),
    };
  },
  read(handle, offset, length) {
    const bytes = Buffer.allocUnsafe(length);
    const count = readSync(handle as number, bytes, 0, length, offset);
    return bytes.subarray(0, count);
  },
  close(handle) {
    closeSync(handle as number);
  },
  watch(parent, onChange, onError) {
    const watcher: FSWatcher = nodeWatch(parent, (_event, filename) => {
      onChange(filename === null ? null : filename.toString());
    });
    watcher.on("error", onError);
    return watcher;
  },
};

export interface FileSourceDeps {
  readonly clock: { now(): number };
  readonly cwd: string;
  readonly fs?: FileSystemPort;
  readonly poll?: FilePollPort;
  readonly onError?: (error: unknown) => void;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FileSnapshot extends FileIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly digest: string;
}

export interface PreparedFileSource {
  readonly path: string;
  readonly canonicalParent: string;
  readonly basename: string;
  readonly on: "create" | "modify";
  readonly baseline?: FileSnapshot;
  /** True only for recovery/rearm, where a durable create may accept presence. */
  readonly allowCreatePresence: boolean;
}

export interface FileSourceHandle {
  /** Runs the exact safety check; tests drive this instead of sleeping. */
  check(): Promise<void>;
  cancel(reason: "cancelled" | "source_timeout"): Promise<void>;
  stop(): Promise<void>;
  readonly done: Promise<void>;
}

export class FileSourceRefusal extends Error {
  constructor(
    readonly code: "path_invalid" | "source_unavailable" | "source_identity",
    message: string,
  ) {
    super(message);
    this.name = "FileSourceRefusal";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function identityOf(stat: FileStat): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertStatSafe(stat: FileStat, path: string): void {
  if (stat.symlink) {
    throw new FileSourceRefusal("source_identity", `Trigger file must not be a symlink: ${path}`);
  }
  if (!stat.regular) {
    throw new FileSourceRefusal("source_identity", `Trigger file is not a regular file: ${path}`);
  }
  if (
    !Number.isSafeInteger(stat.dev) ||
    !Number.isSafeInteger(stat.ino) ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    !Number.isFinite(stat.mtimeMs)
  ) {
    throw new FileSourceRefusal("source_identity", `Trigger file metadata is unsafe: ${path}`);
  }
}

function sampledDigest(fs: FileSystemPort, handle: unknown, size: number): string {
  const sample = Trigger.Constants.FILE_DIGEST_SAMPLE_BYTES;
  const positions =
    size <= sample
      ? [0]
      : [0, Math.max(0, Math.floor((size - sample) / 2)), Math.max(0, size - sample)];
  const unique = [...new Set(positions)];
  const hash = createHash("sha256");
  hash.update(`${size}:`);
  for (const position of unique) {
    const length = Math.min(sample, size - position);
    const bytes = fs.read(handle, position, length);
    hash.update(`${position}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Opens and samples a candidate without following a symlink, then proves the
 * path still names the same descriptor after the read.
 */
function inspectPresent(
  fs: FileSystemPort,
  path: string,
  canonicalParent: string,
): FileSnapshot | undefined {
  let first: FileStat;
  try {
    first = fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  assertStatSafe(first, path);
  const expectedPath = join(canonicalParent, basename(path));
  if (fs.realpath(path) !== expectedPath) {
    throw new FileSourceRefusal(
      "source_identity",
      `Trigger file resolves outside its pinned parent: ${path}`,
    );
  }

  let handle: unknown;
  try {
    handle = fs.openNoFollow(path);
  } catch (error) {
    if (error instanceof FileSourceRefusal) throw error;
    throw new FileSourceRefusal(
      "source_identity",
      `Trigger file could not be opened without following links: ${path}`,
    );
  }
  try {
    const before = fs.fstat(handle);
    assertStatSafe(before, path);
    if (!sameIdentity(first, before)) {
      throw new FileSourceRefusal(
        "source_identity",
        `Trigger file identity changed before it could be read: ${path}`,
      );
    }
    const digest = sampledDigest(fs, handle, before.size);
    const after = fs.fstat(handle);
    assertStatSafe(after, path);
    const pathAfter = fs.lstat(path);
    assertStatSafe(pathAfter, path);
    if (
      !sameIdentity(before, after) ||
      !sameIdentity(after, pathAfter) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new FileSourceRefusal(
        "source_identity",
        `Trigger file identity changed while it was read: ${path}`,
      );
    }
    if (fs.realpath(dirname(path)) !== canonicalParent || fs.realpath(path) !== expectedPath) {
      throw new FileSourceRefusal(
        "source_identity",
        `Trigger file parent identity changed while it was read: ${path}`,
      );
    }
    return { ...identityOf(after), size: after.size, mtimeMs: after.mtimeMs, digest };
  } finally {
    fs.close(handle);
  }
}

function resolveFilePath(path: string, cwd: string): string {
  if (path.trim().length === 0 || path.includes("\0")) {
    throw new FileSourceRefusal("path_invalid", "Trigger file path is empty or contains NUL");
  }
  try {
    return resolve(cwd, path);
  } catch (error) {
    throw new FileSourceRefusal(
      "path_invalid",
      `Trigger file path is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** No watcher is installed here: this is safe to call before durable create. */
export function preflightFileSource(
  source: Extract<Trigger.Source, { kind: "event.file" }>,
  deps: Pick<FileSourceDeps, "cwd" | "fs">,
): PreparedFileSource {
  return prepareFileSource(source, deps, false);
}

/** Recovery/rearm preparation accepts a safe present on:create target. */
export function recoverFileSource(
  source: Extract<Trigger.Source, { kind: "event.file" }>,
  deps: Pick<FileSourceDeps, "cwd" | "fs">,
): PreparedFileSource {
  return prepareFileSource(source, deps, true);
}

function prepareFileSource(
  source: Extract<Trigger.Source, { kind: "event.file" }>,
  deps: Pick<FileSourceDeps, "cwd" | "fs">,
  recovery: boolean,
): PreparedFileSource {
  const fs = deps.fs ?? nativeFileSystem;
  const path = resolveFilePath(source.path, deps.cwd);
  let canonicalParent: string;
  try {
    canonicalParent = fs.realpath(dirname(path));
  } catch {
    throw new FileSourceRefusal(
      "source_unavailable",
      `Trigger file parent is unavailable: ${dirname(path)}`,
    );
  }
  const expected = join(canonicalParent, basename(path));
  const snapshot = inspectPresent(fs, path, canonicalParent);
  if (snapshot !== undefined && fs.realpath(path) !== expected) {
    throw new FileSourceRefusal("source_identity", `Trigger file escaped its parent: ${path}`);
  }
  if (source.on === "create" && snapshot !== undefined && !recovery) {
    throw new FileSourceRefusal(
      "source_identity",
      `Trigger create target already exists: ${path}`,
    );
  }
  if (source.on === "modify" && snapshot === undefined) {
    throw new FileSourceRefusal(
      "source_unavailable",
      `Trigger modify target does not exist: ${path}`,
    );
  }
  return {
    path,
    canonicalParent,
    basename: basename(path),
    on: source.on,
    ...(snapshot === undefined ? {} : { baseline: snapshot }),
    allowCreatePresence: recovery,
  };
}

function snapshotChanged(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.size !== right.size || left.mtimeMs !== right.mtimeMs || left.digest !== right.digest
  );
}

/** Installs the post-commit parent watch and bounded liveness poll. */
export async function startFileSource(
  prepared: PreparedFileSource,
  sink: EventSourceSink,
  deps: FileSourceDeps,
): Promise<FileSourceHandle> {
  const fs = deps.fs ?? nativeFileSystem;
  const poll = deps.poll ?? nativePollPort;
  let watcher: FileWatchHandle | undefined;
  let cancelPoll: (() => void) | undefined;
  let terminalClaimed = false;
  let shutdown = false;
  let checking = false;
  let dirty = false;
  let dirtyRechecks = 0;
  let baseline = prepared.baseline;
  let serial = Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolveDonePromise) => {
    resolveDone = resolveDonePromise;
  });

  function report(error: unknown): void {
    deps.onError?.(error);
  }

  function cleanup(): void {
    cancelPoll?.();
    cancelPoll = undefined;
    try {
      watcher?.close();
    } catch (error) {
      report(error);
    }
    watcher = undefined;
    resolveDone();
  }

  function enqueue(operation: () => void | Promise<void>): Promise<void> {
    const next = serial.then(operation);
    serial = next.catch(report);
    return next;
  }

  async function finish(input: {
    reason: "completed" | "cancelled" | "source_timeout" | "source_error";
    summary: string;
    line?: string;
    detail?: string;
  }): Promise<boolean> {
    if (terminalClaimed || shutdown) return false;
    terminalClaimed = true;
    const summary = sanitizeSourceText(input.summary) ?? "file watcher closed";
    const line = input.line === undefined ? undefined : sanitizeSourceText(input.line);
    const detail =
      input.detail === undefined
        ? undefined
        : sanitizeSourceText(input.detail)?.slice(0, Trigger.Constants.MAX_DETAIL_CHARS);
    await enqueue(() =>
      sink.terminal({
        reason: input.reason,
        ...(line === undefined ? {} : { line }),
        summary,
        at: deps.clock.now(),
        ...(detail === undefined ? {} : { detail }),
      }),
    );
    cleanup();
    return true;
  }

  async function safetyFailure(error: unknown): Promise<void> {
    const detail = error instanceof FileSourceRefusal ? "source_identity" : "source_error";
    await finish({
      reason: "source_error",
      summary: `file watcher safety error: ${detail}`,
      detail,
    });
    report(error);
  }

  async function runSingleCheck(): Promise<void> {
    if (terminalClaimed || shutdown) return;
    let currentParent: string;
    try {
      currentParent = fs.realpath(dirname(prepared.path));
    } catch {
      throw new FileSourceRefusal(
        "source_identity",
        `Trigger file parent disappeared: ${dirname(prepared.path)}`,
      );
    }
    if (currentParent !== prepared.canonicalParent) {
      throw new FileSourceRefusal(
        "source_identity",
        `Trigger file parent identity changed: ${dirname(prepared.path)}`,
      );
    }
    const snapshot = inspectPresent(fs, prepared.path, prepared.canonicalParent);
    if (prepared.on === "create") {
      if (snapshot === undefined) return;
      await finish({
        reason: "completed",
        line: `create ${JSON.stringify(prepared.path)}`,
        summary: "watcher completed",
      });
      return;
    }
    if (snapshot === undefined) {
      throw new FileSourceRefusal(
        "source_identity",
        `Trigger modify target disappeared: ${prepared.path}`,
      );
    }
    if (baseline === undefined) {
      baseline = snapshot;
      return;
    }
    if (!sameIdentity(baseline, snapshot)) {
      throw new FileSourceRefusal(
        "source_identity",
        `Trigger file was replaced: ${prepared.path}`,
      );
    }
    if (!snapshotChanged(baseline, snapshot)) return;
    await finish({
      reason: "completed",
      line: `modify ${JSON.stringify(prepared.path)}`,
      summary: "watcher completed",
    });
  }

  async function check(): Promise<void> {
    if (terminalClaimed || shutdown) return;
    if (checking) {
      dirty = true;
      return;
    }
    checking = true;
    dirtyRechecks = 0;
    try {
      do {
        dirty = false;
        await runSingleCheck();
        if (!dirty || terminalClaimed || shutdown) break;
        dirtyRechecks += 1;
      } while (dirtyRechecks <= Trigger.Constants.FILE_DIRTY_RECHECK_LIMIT);
    } catch (error) {
      await safetyFailure(error);
    } finally {
      checking = false;
      dirty = false;
    }
  }

  function armPoll(): void {
    if (terminalClaimed || shutdown) return;
    cancelPoll?.();
    cancelPoll = poll.arm(Trigger.Constants.FILE_SAFETY_POLL_MS, () => {
      cancelPoll = undefined;
      void check().finally(armPoll);
    });
  }

  // Check once before acquiring the long-lived watcher. Unsafe activation is
  // terminal because the durable row already exists; absence for create is OK.
  await check();
  if (!terminalClaimed) {
    try {
      watcher = fs.watch(
        prepared.canonicalParent,
        (filename) => {
          if (filename === null || filename === prepared.basename) void check();
        },
        (error) => {
          void safetyFailure(error);
        },
      );
    } catch (error) {
      cleanup();
      throw new FileSourceRefusal(
        "source_unavailable",
        `Trigger file watcher could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Closes the check→watch race: a callback and this check serialize through
    // the same dirty-bit gate, and at most one follow-up survives.
    await check();
    armPoll();
  }

  return {
    check,
    async cancel(reason) {
      await finish({
        reason,
        summary:
          reason === "cancelled" ? "file watcher cancelled" : "file watcher timed out",
      });
    },
    async stop() {
      if (shutdown) return;
      shutdown = true;
      terminalClaimed = true;
      cleanup();
      await serial;
    },
    done,
  };
}
